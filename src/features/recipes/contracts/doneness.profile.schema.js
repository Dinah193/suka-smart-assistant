/* eslint-disable no-console */
// C:\Users\larho\suka-smart-assistant\src\features\recipes\contracts\doneness.profile.schema.js
//
// SSA • Doneness Profile Schema
// -----------------------------------------------------------------------------
// Purpose:
//   Defines how a household/user expresses “doneness” preferences across proteins
//   and methods (oven, grill, pan, sous-vide, etc.), plus safety/behavioral rules
//   the RecipeAdapterService can use to adjust imported/manual recipes.
//
// Design goals:
//   - Deterministic + explainable (no AI required)
//   - Strong validation (AJV-ready JSON Schema)
//   - Forward-compatible versioning
//   - Supports: per-protein targets, per-method overrides, per-cut overrides,
//     and global rules such as “never below USDA baseline”, rest times, carryover,
//     and “prefer temperature over time” toggles.
//
// Notes:
//   - SSA primarily operates in the browser; this file contains no Node-only deps.
//   - Temperatures are stored in Fahrenheit internally by default, but schema
//     supports user preference for display/inputs.
//   - “SafetyMode” can enforce minimum internal temperatures regardless of target.
//
// Expected usage:
//   import {
//     DONENESS_PROFILE_SCHEMA,
//     createDefaultDonenessProfile,
//     normalizeDonenessProfile,
//     validateDonenessProfile,
//     assertValidDonenessProfile,
//   } from "@/features/recipes/contracts/doneness.profile.schema";
//
//   const profile = normalizeDonenessProfile(raw);
//   assertValidDonenessProfile(profile);

const SCHEMA_ID = "ssa://schemas/recipes/doneness-profile.schema.json#v1";

const NOW_ISO = () => new Date().toISOString();

/* -------------------------------------------------------------------------- */
/* Enumerations                                                               */
/* -------------------------------------------------------------------------- */

const TEMP_UNITS = ["F", "C"];

const SAFETY_MODES = [
  // No minimum enforcement (not recommended for general users).
  "off",
  // Enforce minimum internal temps for each protein baseline.
  "enforce_minimums",
  // Enforce minimums and prefer “safety-first” adjustments when conflicts occur.
  "strict",
];

const TIME_UNITS = ["sec", "min", "hr"];

const DONENESS_LEVELS = [
  "rare",
  "medium_rare",
  "medium",
  "medium_well",
  "well_done",
];

const PROTEIN_CATEGORIES = [
  // red meat
  "beef",
  "lamb",
  "goat",
  "venison",
  "bison",
  // pork
  "pork",
  // poultry
  "chicken",
  "turkey",
  "duck",
  // seafood
  "fish",
  "shellfish",
  // eggs / misc
  "eggs",
  // composite/unknown
  "mixed",
  "unknown",
];

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

const CUT_TAGS = [
  // generic
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

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
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

function round1(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return undefined;
  return Math.round(x * 10) / 10;
}

/**
 * Convert C to F
 */
function cToF(c) {
  const x = Number(c);
  if (!Number.isFinite(x)) return undefined;
  return (x * 9) / 5 + 32;
}

/**
 * Convert F to C
 */
function fToC(f) {
  const x = Number(f);
  if (!Number.isFinite(x)) return undefined;
  return ((x - 32) * 5) / 9;
}

/**
 * Normalize to internal Fahrenheit storage (while respecting schema ranges).
 */
function normalizeTempToF(value, unit) {
  if (value == null) return undefined;
  const x = Number(value);
  if (!Number.isFinite(x)) return undefined;
  if (unit === "C") return cToF(x);
  return x;
}

function normalizeTimeSec(value, unit) {
  if (value == null) return undefined;
  const x = Number(value);
  if (!Number.isFinite(x)) return undefined;
  if (unit === "hr") return x * 3600;
  if (unit === "min") return x * 60;
  return x;
}

/* -------------------------------------------------------------------------- */
/* Default baselines (F)                                                      */
/* -------------------------------------------------------------------------- */
/**
 * “Baselines” are conservative minimums used by safety enforcement.
 * These are *not* a substitute for local regulations or professional guidance.
 * Users can override per household if desired.
 */
const DEFAULT_BASELINE_MIN_INTERNAL_F = {
  beef: 145, // includes whole cuts; ground handled separately
  lamb: 145,
  goat: 145,
  venison: 145,
  bison: 145,

  pork: 145,

  chicken: 165,
  turkey: 165,
  duck: 165,

  fish: 145,
  shellfish: 145,

  eggs: 160,

  mixed: 145,
  unknown: 145,
};

const DEFAULT_BASELINE_MIN_INTERNAL_F_GROUND = {
  beef: 160,
  lamb: 160,
  goat: 160,
  venison: 160,
  bison: 160,
  pork: 160,
  chicken: 165,
  turkey: 165,
  duck: 165,
  fish: 145,
  shellfish: 145,
  eggs: 160,
  mixed: 160,
  unknown: 160,
};

/* -------------------------------------------------------------------------- */
/* Schema                                                                     */
/* -------------------------------------------------------------------------- */

const DONENESS_PROFILE_SCHEMA = {
  $id: SCHEMA_ID,
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "SSA Doneness Profile",
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "id", "scope", "preferences", "rules", "meta"],
  properties: {
    schemaVersion: {
      type: "integer",
      const: 1,
      description: "Schema version for forward-compatible migrations.",
    },

    id: {
      type: "string",
      minLength: 8,
      maxLength: 128,
      description:
        "Stable id (uuid-like). Can be household-scoped or user-scoped.",
    },

    scope: {
      type: "object",
      additionalProperties: false,
      required: ["level", "householdId"],
      properties: {
        level: {
          type: "string",
          enum: ["household_default", "user_override"],
          description:
            "household_default applies to all; user_override can refine/override.",
        },
        householdId: {
          type: "string",
          minLength: 1,
          maxLength: 128,
        },
        userId: {
          type: ["string", "null"],
          default: null,
          maxLength: 128,
          description:
            "If level=user_override, identifies the user; otherwise null.",
        },
        appliesTo: {
          type: "object",
          additionalProperties: false,
          default: {},
          properties: {
            proteinCategories: {
              type: "array",
              default: [],
              items: { type: "string", enum: PROTEIN_CATEGORIES },
              uniqueItems: true,
              description:
                "Optional filter. If set, profile applies only to these categories.",
            },
            methods: {
              type: "array",
              default: [],
              items: { type: "string", enum: COOK_METHODS },
              uniqueItems: true,
              description:
                "Optional filter. If set, profile applies only to these methods.",
            },
          },
        },
      },
      allOf: [
        {
          if: {
            properties: { level: { const: "user_override" } },
            required: ["level"],
          },
          then: {
            required: ["userId"],
            properties: { userId: { type: "string", minLength: 1 } },
          },
          else: {
            properties: { userId: { type: ["null"] } },
          },
        },
      ],
    },

    preferences: {
      type: "object",
      additionalProperties: false,
      required: ["displayUnits", "defaultTargets", "overrides"],
      properties: {
        displayUnits: {
          type: "object",
          additionalProperties: false,
          required: ["temperature", "time"],
          properties: {
            temperature: { type: "string", enum: TEMP_UNITS, default: "F" },
            time: { type: "string", enum: TIME_UNITS, default: "min" },
          },
        },

        /**
         * Default targets are the first pass for recipe adaptation.
         * - Users can provide either a donenessLevel mapping OR explicit internalTempF.
         * - Storage: internalTempF (F) is the canonical internal form.
         */
        defaultTargets: {
          type: "object",
          additionalProperties: false,
          required: ["byProtein"],
          properties: {
            byProtein: {
              type: "object",
              description:
                "Default target by protein category (whole cuts unless overridden by cutTag=ground).",
              additionalProperties: false,
              required: PROTEIN_CATEGORIES,
              properties: PROTEIN_CATEGORIES.reduce((acc, k) => {
                acc[k] = {
                  $ref: "#/$defs/TargetSpec",
                };
                return acc;
              }, {}),
            },

            byDonenessLevel: {
              type: "object",
              default: {},
              description:
                "Optional global map from doneness level to target temperature (F). Useful when recipes specify 'medium rare'.",
              additionalProperties: false,
              properties: DONENESS_LEVELS.reduce((acc, lvl) => {
                acc[lvl] = { $ref: "#/$defs/TempSpec" };
                return acc;
              }, {}),
            },
          },
        },

        overrides: {
          type: "object",
          additionalProperties: false,
          required: ["byMethod", "byCut"],
          properties: {
            /**
             * Overrides by method (e.g., sous-vide targets differ from grill targets).
             */
            byMethod: {
              type: "object",
              default: {},
              additionalProperties: false,
              properties: COOK_METHODS.reduce((acc, m) => {
                acc[m] = {
                  type: "object",
                  additionalProperties: false,
                  required: ["enabled", "byProtein"],
                  properties: {
                    enabled: { type: "boolean", default: true },
                    byProtein: {
                      type: "object",
                      additionalProperties: false,
                      required: PROTEIN_CATEGORIES,
                      properties: PROTEIN_CATEGORIES.reduce((a2, k) => {
                        a2[k] = { $ref: "#/$defs/TargetSpec" };
                        return a2;
                      }, {}),
                    },
                  },
                };
                return acc;
              }, {}),
            },

            /**
             * Overrides by cut (e.g., ground beef, chicken thighs).
             * Keyed by cutTag; each cutTag can optionally define per-protein targets.
             */
            byCut: {
              type: "object",
              default: {},
              additionalProperties: false,
              properties: CUT_TAGS.reduce((acc, tag) => {
                acc[tag] = {
                  type: "object",
                  additionalProperties: false,
                  required: ["enabled", "byProtein"],
                  properties: {
                    enabled: { type: "boolean", default: true },
                    byProtein: {
                      type: "object",
                      additionalProperties: false,
                      required: PROTEIN_CATEGORIES,
                      properties: PROTEIN_CATEGORIES.reduce((a2, k) => {
                        a2[k] = { $ref: "#/$defs/TargetSpec" };
                        return a2;
                      }, {}),
                    },
                  },
                };
                return acc;
              }, {}),
            },
          },
        },
      },
    },

    rules: {
      type: "object",
      additionalProperties: false,
      required: [
        "safetyMode",
        "baselineMinimums",
        "preferTemperatureOverTime",
        "carryoverCooking",
        "resting",
        "conflictResolution",
        "notes",
      ],
      properties: {
        safetyMode: {
          type: "string",
          enum: SAFETY_MODES,
          default: "enforce_minimums",
        },

        /**
         * Minimum internal temperatures used when safetyMode != off.
         * Canonical storage is Fahrenheit.
         */
        baselineMinimums: {
          type: "object",
          additionalProperties: false,
          required: ["wholeCutsF", "groundF"],
          properties: {
            wholeCutsF: {
              type: "object",
              additionalProperties: false,
              required: PROTEIN_CATEGORIES,
              properties: PROTEIN_CATEGORIES.reduce((acc, k) => {
                acc[k] = { $ref: "#/$defs/TempF" };
                return acc;
              }, {}),
            },
            groundF: {
              type: "object",
              additionalProperties: false,
              required: PROTEIN_CATEGORIES,
              properties: PROTEIN_CATEGORIES.reduce((acc, k) => {
                acc[k] = { $ref: "#/$defs/TempF" };
                return acc;
              }, {}),
            },
          },
        },

        preferTemperatureOverTime: {
          type: "boolean",
          default: true,
          description:
            "When both time and temperature are present, prioritize temperature targets if true.",
        },

        carryoverCooking: {
          type: "object",
          additionalProperties: false,
          required: ["enabled", "defaultCarryoverF", "methodAdjustments"],
          properties: {
            enabled: { type: "boolean", default: true },
            defaultCarryoverF: {
              $ref: "#/$defs/TempDeltaF",
              default: 5,
              description:
                "Estimated carryover after removal from heat, used for target adjustments.",
            },
            methodAdjustments: {
              type: "object",
              default: {},
              additionalProperties: false,
              properties: COOK_METHODS.reduce((acc, m) => {
                acc[m] = { $ref: "#/$defs/TempDeltaF" };
                return acc;
              }, {}),
              description: "Optional per-method carryover delta overrides (F).",
            },
          },
        },

        resting: {
          type: "object",
          additionalProperties: false,
          required: ["enabled", "defaultRestSeconds", "byProtein"],
          properties: {
            enabled: { type: "boolean", default: true },
            defaultRestSeconds: {
              type: "integer",
              minimum: 0,
              maximum: 4 * 3600,
              default: 600,
              description: "Default rest time after cooking (in seconds).",
            },
            byProtein: {
              type: "object",
              additionalProperties: false,
              required: PROTEIN_CATEGORIES,
              properties: PROTEIN_CATEGORIES.reduce((acc, k) => {
                acc[k] = {
                  type: "integer",
                  minimum: 0,
                  maximum: 4 * 3600,
                  default: 600,
                };
                return acc;
              }, {}),
            },
          },
        },

        conflictResolution: {
          type: "object",
          additionalProperties: false,
          required: [
            "whenRecipeTargetBelowUserTarget",
            "whenUserTargetBelowSafetyMinimum",
            "whenRecipeHasOnlyDonenessWords",
          ],
          properties: {
            whenRecipeTargetBelowUserTarget: {
              type: "string",
              enum: ["prefer_user", "prefer_recipe", "ask_user"],
              default: "prefer_user",
              description:
                "If recipe says 130F but user prefers 145F, what to do?",
            },
            whenUserTargetBelowSafetyMinimum: {
              type: "string",
              enum: ["raise_to_minimum", "warn_and_allow", "ask_user"],
              default: "raise_to_minimum",
              description:
                "If user prefers below baseline and safetyMode != off, what to do?",
            },
            whenRecipeHasOnlyDonenessWords: {
              type: "string",
              enum: ["map_using_profile", "ask_user", "leave_unchanged"],
              default: "map_using_profile",
              description:
                "If recipe says 'cook to medium', how to translate it?",
            },
          },
        },

        notes: {
          type: "string",
          default: "",
          maxLength: 4000,
        },
      },
    },

    meta: {
      type: "object",
      additionalProperties: false,
      required: ["createdAt", "updatedAt", "source", "tags"],
      properties: {
        createdAt: { type: "string", format: "date-time" },
        updatedAt: { type: "string", format: "date-time" },
        source: {
          type: "string",
          default: "features/recipes/contracts/doneness.profile.schema",
        },
        tags: {
          type: "array",
          default: [],
          items: { type: "string", minLength: 1, maxLength: 64 },
          uniqueItems: true,
        },
      },
    },
  },

  $defs: {
    TempF: {
      type: "number",
      minimum: 32,
      maximum: 450,
      description: "Temperature (F).",
    },

    TempDeltaF: {
      type: "number",
      minimum: -50,
      maximum: 80,
      description:
        "Temperature delta (F) (positive for carryover, negative for cooling).",
    },

    TempSpec: {
      type: "object",
      additionalProperties: false,
      required: ["value", "unit"],
      properties: {
        value: { type: "number", minimum: -50, maximum: 300 },
        unit: { type: "string", enum: TEMP_UNITS, default: "F" },
      },
      description:
        "Temperature with explicit unit (input-friendly). Canonical storage is F elsewhere.",
    },

    /**
     * TargetSpec supports:
     *  - internalTempF (canonical) OR input tempSpec + auto convert by normalizer.
     *  - donenessLevel (optional) when recipe is described as rare/medium/etc.
     *  - toleranceF for acceptable range
     *  - probePriority (where to probe for thick cuts)
     */
    TargetSpec: {
      type: "object",
      additionalProperties: false,
      required: ["enabled", "internalTempF", "toleranceF", "donenessLevel"],
      properties: {
        enabled: { type: "boolean", default: true },

        internalTempF: {
          $ref: "#/$defs/TempF",
          description: "Canonical internal target temperature (F).",
        },

        toleranceF: {
          type: "number",
          minimum: 0,
          maximum: 25,
          default: 3,
          description: "Acceptable +/- tolerance around internalTempF.",
        },

        donenessLevel: {
          type: ["string", "null"],
          enum: [...DONENESS_LEVELS, null],
          default: null,
          description:
            "Optional doneness label; can be mapped to internal temp if desired.",
        },

        probePriority: {
          type: "string",
          enum: [
            "thickest_center",
            "near_bone_avoid_bone",
            "multiple_spots",
            "surface_then_center",
          ],
          default: "thickest_center",
        },

        /**
         * Optional user-facing input convenience: if present, normalizer will
         * convert it into internalTempF and then may drop it.
         */
        inputTemp: {
          anyOf: [{ $ref: "#/$defs/TempSpec" }, { type: "null" }],
          default: null,
        },
      },
    },
  },
};

/* -------------------------------------------------------------------------- */
/* Defaults builder                                                           */
/* -------------------------------------------------------------------------- */

function makeDefaultTarget(tempF, lvl = null) {
  return {
    enabled: true,
    internalTempF: round1(clampNumber(tempF, 32, 450)),
    toleranceF: 3,
    donenessLevel: lvl,
    probePriority: "thickest_center",
    inputTemp: null,
  };
}

function makeDefaultByProteinTargets() {
  // Reasonable household defaults:
  // - Red meat: medium (145F) by default
  // - Pork: 145F
  // - Poultry: 165F
  // - Fish/shellfish: 145F
  // - Eggs: 160F
  const out = {};
  for (const p of PROTEIN_CATEGORIES) {
    const min = DEFAULT_BASELINE_MIN_INTERNAL_F[p] ?? 145;
    out[p] = makeDefaultTarget(min, null);
  }
  return out;
}

function makeDefaultMethodOverrides() {
  const out = {};
  for (const m of COOK_METHODS) {
    out[m] = {
      enabled: true,
      byProtein: makeDefaultByProteinTargets(),
    };
  }
  // Method-specific typical tweaks (optional):
  // Sous-vide can target lower with longer holds, but safetyMode may lift it.
  out.sous_vide.byProtein.beef = makeDefaultTarget(135, "medium_rare");
  out.sous_vide.byProtein.lamb = makeDefaultTarget(135, "medium_rare");
  out.sous_vide.byProtein.goat = makeDefaultTarget(140, "medium");
  // Smoking/slow cooking often ends higher for poultry, but keep baseline.
  return out;
}

function makeDefaultCutOverrides() {
  const out = {};
  for (const tag of CUT_TAGS) {
    out[tag] = {
      enabled: true,
      byProtein: makeDefaultByProteinTargets(),
    };
  }
  // Ground meats should default to ground baselines.
  for (const p of PROTEIN_CATEGORIES) {
    const groundMin = DEFAULT_BASELINE_MIN_INTERNAL_F_GROUND[p] ?? 160;
    out.ground.byProtein[p] = makeDefaultTarget(groundMin, null);
  }
  return out;
}

function makeDefaultDonenessLevelMap() {
  // General guideline mapping (user can change freely):
  // These are typical steak-style mappings for red meats.
  return {
    rare: { value: 125, unit: "F" },
    medium_rare: { value: 135, unit: "F" },
    medium: { value: 145, unit: "F" },
    medium_well: { value: 155, unit: "F" },
    well_done: { value: 165, unit: "F" },
  };
}

function makeDefaultBaselineMinimums() {
  const wholeCutsF = {};
  const groundF = {};
  for (const p of PROTEIN_CATEGORIES) {
    wholeCutsF[p] = round1(
      clampNumber(DEFAULT_BASELINE_MIN_INTERNAL_F[p] ?? 145, 32, 450)
    );
    groundF[p] = round1(
      clampNumber(DEFAULT_BASELINE_MIN_INTERNAL_F_GROUND[p] ?? 160, 32, 450)
    );
  }
  return { wholeCutsF, groundF };
}

/**
 * Create a new default profile.
 * @param {object} args
 * @param {string} args.id
 * @param {string} args.householdId
 * @param {string=} args.userId
 * @param {string=} args.level "household_default" | "user_override"
 */
function createDefaultDonenessProfile(args = {}) {
  const id =
    typeof args.id === "string" && args.id
      ? args.id
      : `doneness_${Math.random().toString(16).slice(2)}_${Date.now()}`;
  const householdId =
    typeof args.householdId === "string" && args.householdId
      ? args.householdId
      : "household_default";
  const level =
    args.level === "user_override" ? "user_override" : "household_default";
  const userId =
    level === "user_override"
      ? typeof args.userId === "string" && args.userId
        ? args.userId
        : "user_default"
      : null;

  const createdAt = NOW_ISO();

  return {
    schemaVersion: 1,
    id,
    scope: {
      level,
      householdId,
      userId,
      appliesTo: {
        proteinCategories: [],
        methods: [],
      },
    },
    preferences: {
      displayUnits: {
        temperature: "F",
        time: "min",
      },
      defaultTargets: {
        byProtein: makeDefaultByProteinTargets(),
        byDonenessLevel: makeDefaultDonenessLevelMap(),
      },
      overrides: {
        byMethod: makeDefaultMethodOverrides(),
        byCut: makeDefaultCutOverrides(),
      },
    },
    rules: {
      safetyMode: "enforce_minimums",
      baselineMinimums: makeDefaultBaselineMinimums(),
      preferTemperatureOverTime: true,
      carryoverCooking: {
        enabled: true,
        defaultCarryoverF: 5,
        methodAdjustments: {
          grill: 7,
          pan_sear: 6,
          roast: 6,
          bake: 4,
          smoke: 5,
          sous_vide: 2,
          air_fry: 4,
          broil: 5,
        },
      },
      resting: {
        enabled: true,
        defaultRestSeconds: 600,
        byProtein: PROTEIN_CATEGORIES.reduce((acc, p) => {
          // poultry and red meat generally benefit from rest; fish less so.
          acc[p] = p === "fish" || p === "shellfish" ? 180 : 600;
          return acc;
        }, {}),
      },
      conflictResolution: {
        whenRecipeTargetBelowUserTarget: "prefer_user",
        whenUserTargetBelowSafetyMinimum: "raise_to_minimum",
        whenRecipeHasOnlyDonenessWords: "map_using_profile",
      },
      notes: "",
    },
    meta: {
      createdAt,
      updatedAt: createdAt,
      source: "features/recipes/contracts/doneness.profile.schema",
      tags: [],
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Normalization + validation helpers                                          */
/* -------------------------------------------------------------------------- */

/**
 * Normalize a profile:
 *  - Ensure required objects exist
 *  - Convert any TargetSpec.inputTemp into internalTempF (F)
 *  - Clamp temperatures and times to safe ranges
 *  - Ensure baselines present for all protein categories
 *  - Ensure overrides contain full matrices (method x protein, cut x protein)
 *
 * This does not “apply safety” (i.e., raising targets); that is runtime logic in
 * the RecipeAdapterService. This only normalizes data shape and units.
 */
function normalizeDonenessProfile(raw, opts = {}) {
  const { quiet = true } = opts;
  const base = isPlainObject(raw) ? deepClone(raw) : {};
  const out =
    isPlainObject(base) && base.schemaVersion === 1
      ? base
      : createDefaultDonenessProfile({
          id: base.id,
          householdId: base?.scope?.householdId,
          userId: base?.scope?.userId,
          level: base?.scope?.level,
        });

  // Ensure minimal meta timestamps
  if (!out.meta) out.meta = {};
  if (!out.meta.createdAt) out.meta.createdAt = NOW_ISO();
  out.meta.updatedAt = NOW_ISO();

  // Ensure baseline minimum matrices
  if (!out.rules) out.rules = {};
  if (!out.rules.baselineMinimums)
    out.rules.baselineMinimums = makeDefaultBaselineMinimums();
  if (!out.rules.baselineMinimums.wholeCutsF)
    out.rules.baselineMinimums.wholeCutsF = {};
  if (!out.rules.baselineMinimums.groundF)
    out.rules.baselineMinimums.groundF = {};

  for (const p of PROTEIN_CATEGORIES) {
    const w = out.rules.baselineMinimums.wholeCutsF[p];
    const g = out.rules.baselineMinimums.groundF[p];

    out.rules.baselineMinimums.wholeCutsF[p] = round1(
      clampNumber(
        w != null ? w : DEFAULT_BASELINE_MIN_INTERNAL_F[p] ?? 145,
        32,
        450
      )
    );
    out.rules.baselineMinimums.groundF[p] = round1(
      clampNumber(
        g != null ? g : DEFAULT_BASELINE_MIN_INTERNAL_F_GROUND[p] ?? 160,
        32,
        450
      )
    );
  }

  // Ensure display units
  if (!out.preferences) out.preferences = {};
  if (!out.preferences.displayUnits) out.preferences.displayUnits = {};
  if (!TEMP_UNITS.includes(out.preferences.displayUnits.temperature)) {
    out.preferences.displayUnits.temperature = "F";
  }
  if (!TIME_UNITS.includes(out.preferences.displayUnits.time)) {
    out.preferences.displayUnits.time = "min";
  }

  // Ensure defaultTargets.byProtein
  if (!out.preferences.defaultTargets) out.preferences.defaultTargets = {};
  if (!out.preferences.defaultTargets.byProtein) {
    out.preferences.defaultTargets.byProtein = makeDefaultByProteinTargets();
  }
  for (const p of PROTEIN_CATEGORIES) {
    if (!out.preferences.defaultTargets.byProtein[p]) {
      out.preferences.defaultTargets.byProtein[p] = makeDefaultTarget(
        DEFAULT_BASELINE_MIN_INTERNAL_F[p] ?? 145,
        null
      );
    }
    normalizeTargetSpecInPlace(
      out.preferences.defaultTargets.byProtein[p],
      out.preferences.displayUnits.temperature
    );
  }

  // Ensure doneness mapping exists
  if (!out.preferences.defaultTargets.byDonenessLevel) {
    out.preferences.defaultTargets.byDonenessLevel =
      makeDefaultDonenessLevelMap();
  }
  // Normalize byDonenessLevel into consistent units object {value, unit}
  for (const lvl of DONENESS_LEVELS) {
    const spec = out.preferences.defaultTargets.byDonenessLevel[lvl];
    if (!spec || !isPlainObject(spec)) {
      out.preferences.defaultTargets.byDonenessLevel[lvl] = {
        value: makeDefaultDonenessLevelMap()[lvl].value,
        unit: "F",
      };
      continue;
    }
    const unit = TEMP_UNITS.includes(spec.unit) ? spec.unit : "F";
    const v = clampNumber(spec.value, -50, 300);
    out.preferences.defaultTargets.byDonenessLevel[lvl] = {
      value: v == null ? makeDefaultDonenessLevelMap()[lvl].value : round1(v),
      unit,
    };
  }

  // Ensure overrides
  if (!out.preferences.overrides) out.preferences.overrides = {};
  if (!out.preferences.overrides.byMethod)
    out.preferences.overrides.byMethod = {};
  if (!out.preferences.overrides.byCut) out.preferences.overrides.byCut = {};

  // Methods
  for (const m of COOK_METHODS) {
    if (
      !out.preferences.overrides.byMethod[m] ||
      !isPlainObject(out.preferences.overrides.byMethod[m])
    ) {
      out.preferences.overrides.byMethod[m] = {
        enabled: true,
        byProtein: makeDefaultByProteinTargets(),
      };
    }
    if (typeof out.preferences.overrides.byMethod[m].enabled !== "boolean") {
      out.preferences.overrides.byMethod[m].enabled = true;
    }
    if (!out.preferences.overrides.byMethod[m].byProtein) {
      out.preferences.overrides.byMethod[m].byProtein =
        makeDefaultByProteinTargets();
    }
    for (const p of PROTEIN_CATEGORIES) {
      if (!out.preferences.overrides.byMethod[m].byProtein[p]) {
        out.preferences.overrides.byMethod[m].byProtein[p] = makeDefaultTarget(
          DEFAULT_BASELINE_MIN_INTERNAL_F[p] ?? 145,
          null
        );
      }
      normalizeTargetSpecInPlace(
        out.preferences.overrides.byMethod[m].byProtein[p],
        out.preferences.displayUnits.temperature
      );
    }
  }

  // Cuts
  for (const tag of CUT_TAGS) {
    if (
      !out.preferences.overrides.byCut[tag] ||
      !isPlainObject(out.preferences.overrides.byCut[tag])
    ) {
      out.preferences.overrides.byCut[tag] = {
        enabled: true,
        byProtein: makeDefaultByProteinTargets(),
      };
    }
    if (typeof out.preferences.overrides.byCut[tag].enabled !== "boolean") {
      out.preferences.overrides.byCut[tag].enabled = true;
    }
    if (!out.preferences.overrides.byCut[tag].byProtein) {
      out.preferences.overrides.byCut[tag].byProtein =
        makeDefaultByProteinTargets();
    }
    for (const p of PROTEIN_CATEGORIES) {
      if (!out.preferences.overrides.byCut[tag].byProtein[p]) {
        const isGround = tag === "ground";
        const baseTemp = isGround
          ? DEFAULT_BASELINE_MIN_INTERNAL_F_GROUND[p] ?? 160
          : DEFAULT_BASELINE_MIN_INTERNAL_F[p] ?? 145;
        out.preferences.overrides.byCut[tag].byProtein[p] = makeDefaultTarget(
          baseTemp,
          null
        );
      }
      normalizeTargetSpecInPlace(
        out.preferences.overrides.byCut[tag].byProtein[p],
        out.preferences.displayUnits.temperature
      );
    }
  }

  // Rules: carryover + rest constraints
  if (!out.rules.carryoverCooking) out.rules.carryoverCooking = {};
  if (typeof out.rules.carryoverCooking.enabled !== "boolean")
    out.rules.carryoverCooking.enabled = true;
  out.rules.carryoverCooking.defaultCarryoverF = round1(
    clampNumber(out.rules.carryoverCooking.defaultCarryoverF ?? 5, -50, 80)
  );
  if (!out.rules.carryoverCooking.methodAdjustments)
    out.rules.carryoverCooking.methodAdjustments = {};
  for (const m of COOK_METHODS) {
    const v = out.rules.carryoverCooking.methodAdjustments[m];
    if (v == null) continue;
    out.rules.carryoverCooking.methodAdjustments[m] = round1(
      clampNumber(v, -50, 80)
    );
  }

  if (!out.rules.resting) out.rules.resting = {};
  if (typeof out.rules.resting.enabled !== "boolean")
    out.rules.resting.enabled = true;
  out.rules.resting.defaultRestSeconds = Math.round(
    clampNumber(out.rules.resting.defaultRestSeconds ?? 600, 0, 4 * 3600)
  );
  if (!out.rules.resting.byProtein) out.rules.resting.byProtein = {};
  for (const p of PROTEIN_CATEGORIES) {
    const v = out.rules.resting.byProtein[p];
    out.rules.resting.byProtein[p] = Math.round(
      clampNumber(v ?? out.rules.resting.defaultRestSeconds, 0, 4 * 3600)
    );
  }

  if (!SAFETY_MODES.includes(out.rules.safetyMode))
    out.rules.safetyMode = "enforce_minimums";

  // Last sanity: validate (soft)
  const vr = validateDonenessProfile(out);
  if (!vr.ok && !quiet) {
    console.warn(
      "[SSA][doneness] normalize produced invalid profile:",
      vr.errors
    );
  }

  return out;
}

/**
 * Normalizes a TargetSpec in-place:
 * - Ensure booleans and defaults
 * - Convert inputTemp to internalTempF (F) and clamp
 */
function normalizeTargetSpecInPlace(target, displayUnit) {
  if (!isPlainObject(target)) return;

  if (typeof target.enabled !== "boolean") target.enabled = true;

  // If inputTemp exists, convert it and set internalTempF
  if (target.inputTemp && isPlainObject(target.inputTemp)) {
    const unit = TEMP_UNITS.includes(target.inputTemp.unit)
      ? target.inputTemp.unit
      : displayUnit && TEMP_UNITS.includes(displayUnit)
      ? displayUnit
      : "F";
    const tempF = normalizeTempToF(target.inputTemp.value, unit);
    if (tempF != null) target.internalTempF = tempF;
    // Keep inputTemp for UI if desired; adapters can drop it. We'll keep it.
    target.inputTemp.unit = unit;
    target.inputTemp.value = round1(
      clampNumber(target.inputTemp.value, -50, 300)
    );
  }

  const t = clampNumber(target.internalTempF, 32, 450);
  target.internalTempF =
    t == null ? round1(clampNumber(145, 32, 450)) : round1(t);

  const tol = clampNumber(target.toleranceF, 0, 25);
  target.toleranceF = tol == null ? 3 : round1(tol);

  if (target.donenessLevel === undefined) target.donenessLevel = null;
  if (
    target.donenessLevel !== null &&
    !DONENESS_LEVELS.includes(target.donenessLevel)
  ) {
    target.donenessLevel = null;
  }

  const pp = target.probePriority;
  const allowedPP = [
    "thickest_center",
    "near_bone_avoid_bone",
    "multiple_spots",
    "surface_then_center",
  ];
  if (!allowedPP.includes(pp)) target.probePriority = "thickest_center";
}

/* -------------------------------------------------------------------------- */
/* AJV integration (optional, but production-friendly)                         */
/* -------------------------------------------------------------------------- */

/**
 * validateDonenessProfile
 * - Browser-safe: does NOT use Node `require`.
 * - If an Ajv instance is provided, uses it.
 * - Otherwise performs a lightweight structural validation.
 *
 * @param {object} profile
 * @param {object=} opts
 * @param {any=} opts.ajv Ajv instance (optional) to compile+validate with.
 * @param {boolean=} opts.withFormats If true and ajv supports formats, add them.
 * @returns {{ ok: boolean, errors: Array<{path:string,message:string}> }}
 */
function validateDonenessProfile(profile, opts = {}) {
  const ajv = opts?.ajv;

  if (ajv && typeof ajv.compile === "function") {
    try {
      // optional addFormats support if the host attached it to ajv
      if (opts.withFormats && typeof ajv.addFormat === "function") {
        // nothing to do; formats likely already configured in app-level Ajv
      }
      const validate = ajv.compile(DONENESS_PROFILE_SCHEMA);
      const ok = !!validate(profile);
      const errors = (validate.errors || []).map((er) => ({
        path: er.instancePath || er.schemaPath || "",
        message: er.message || "invalid",
      }));
      return { ok, errors };
    } catch (e) {
      // Fall through to lightweight validation
      return lightweightValidate(profile);
    }
  }

  return lightweightValidate(profile);
}

function lightweightValidate(profile) {
  const errors = [];

  if (!isPlainObject(profile)) {
    return {
      ok: false,
      errors: [{ path: "", message: "Profile must be an object" }],
    };
  }
  if (profile.schemaVersion !== 1) {
    errors.push({ path: "/schemaVersion", message: "schemaVersion must be 1" });
  }
  if (typeof profile.id !== "string" || profile.id.length < 8) {
    errors.push({ path: "/id", message: "id must be a string (minLength 8)" });
  }
  if (!isPlainObject(profile.scope)) {
    errors.push({ path: "/scope", message: "scope must be an object" });
  } else {
    if (!["household_default", "user_override"].includes(profile.scope.level)) {
      errors.push({
        path: "/scope/level",
        message: "scope.level must be household_default or user_override",
      });
    }
    if (
      typeof profile.scope.householdId !== "string" ||
      !profile.scope.householdId
    ) {
      errors.push({
        path: "/scope/householdId",
        message: "scope.householdId required",
      });
    }
    if (profile.scope.level === "user_override") {
      if (typeof profile.scope.userId !== "string" || !profile.scope.userId) {
        errors.push({
          path: "/scope/userId",
          message: "scope.userId required for user_override",
        });
      }
    }
  }

  // Quick check: defaultTargets.byProtein exists with all categories
  const byProtein = profile?.preferences?.defaultTargets?.byProtein;
  if (!isPlainObject(byProtein)) {
    errors.push({
      path: "/preferences/defaultTargets/byProtein",
      message: "defaultTargets.byProtein must be an object",
    });
  } else {
    for (const p of PROTEIN_CATEGORIES) {
      if (!isPlainObject(byProtein[p])) {
        errors.push({
          path: `/preferences/defaultTargets/byProtein/${p}`,
          message: `missing TargetSpec for ${p}`,
        });
      }
    }
  }

  // Baselines
  const baselines = profile?.rules?.baselineMinimums;
  if (
    !isPlainObject(baselines) ||
    !isPlainObject(baselines.wholeCutsF) ||
    !isPlainObject(baselines.groundF)
  ) {
    errors.push({
      path: "/rules/baselineMinimums",
      message: "baselineMinimums.wholeCutsF and groundF must exist",
    });
  }

  return { ok: errors.length === 0, errors };
}

function assertValidDonenessProfile(profile, opts = {}) {
  const r = validateDonenessProfile(profile, opts);
  if (!r.ok) {
    const msg =
      "[SSA][doneness] Invalid DonenessProfile: " +
      r.errors.map((e) => `${e.path}: ${e.message}`).join("; ");
    const err = new Error(msg);
    err.name = "DonenessProfileValidationError";
    err.details = r.errors;
    throw err;
  }
}

/* -------------------------------------------------------------------------- */
/* Convenience utilities for recipe adaptation                                 */
/* -------------------------------------------------------------------------- */

/**
 * Resolve a target temperature (F) for a given protein + method + cutTag.
 * This is a pure helper (does not apply safety). RecipeAdapterService can call
 * this and then apply safety rules/overrides as needed.
 *
 * @param {object} profile normalized doneness profile
 * @param {object} q
 * @param {string} q.proteinCategory one of PROTEIN_CATEGORIES
 * @param {string=} q.method one of COOK_METHODS
 * @param {string=} q.cutTag one of CUT_TAGS
 * @param {string|number|null=} q.recipeDonenessLabel optional (e.g. "medium rare")
 * @returns {{ tempF: number, toleranceF: number, source: string }}
 */
function resolveDonenessTarget(profile, q) {
  const p =
    q?.proteinCategory && PROTEIN_CATEGORIES.includes(q.proteinCategory)
      ? q.proteinCategory
      : "unknown";
  const m = q?.method && COOK_METHODS.includes(q.method) ? q.method : null;
  const cut = q?.cutTag && CUT_TAGS.includes(q.cutTag) ? q.cutTag : null;

  // 1) Cut override (if enabled)
  if (cut) {
    const cutNode = profile?.preferences?.overrides?.byCut?.[cut];
    if (
      cutNode &&
      cutNode.enabled &&
      cutNode.byProtein &&
      cutNode.byProtein[p]
    ) {
      const t = cutNode.byProtein[p];
      return {
        tempF: t.internalTempF,
        toleranceF: t.toleranceF,
        source: `cut:${cut}`,
      };
    }
  }

  // 2) Method override (if enabled)
  if (m) {
    const methodNode = profile?.preferences?.overrides?.byMethod?.[m];
    if (
      methodNode &&
      methodNode.enabled &&
      methodNode.byProtein &&
      methodNode.byProtein[p]
    ) {
      const t = methodNode.byProtein[p];
      return {
        tempF: t.internalTempF,
        toleranceF: t.toleranceF,
        source: `method:${m}`,
      };
    }
  }

  // 3) Recipe doneness label mapping (if present and configured)
  const label = normalizeDonenessLabel(q?.recipeDonenessLabel);
  if (label) {
    const spec = profile?.preferences?.defaultTargets?.byDonenessLevel?.[label];
    if (spec && isPlainObject(spec)) {
      const tempF = normalizeTempToF(spec.value, spec.unit || "F");
      if (tempF != null) {
        return {
          tempF: round1(clampNumber(tempF, 32, 450)),
          toleranceF: 3,
          source: `label:${label}`,
        };
      }
    }
  }

  // 4) Protein default
  const def = profile?.preferences?.defaultTargets?.byProtein?.[p];
  if (def) {
    return {
      tempF: def.internalTempF,
      toleranceF: def.toleranceF,
      source: `protein:${p}`,
    };
  }

  // 5) Fallback
  return { tempF: 145, toleranceF: 3, source: "fallback" };
}

function normalizeDonenessLabel(label) {
  if (label == null) return null;
  const s = String(label).trim().toLowerCase();
  if (!s) return null;

  // common variants
  if (s === "medium-rare" || s === "med rare" || s === "med-rare")
    return "medium_rare";
  if (s === "medium well" || s === "medium-well" || s === "med well")
    return "medium_well";
  if (s === "well done" || s === "well-done") return "well_done";
  if (s === "rare") return "rare";
  if (s === "medium") return "medium";
  if (s === "well") return "well_done";
  if (DONENESS_LEVELS.includes(s)) return s;
  return null;
}

/**
 * Apply safety minimums to a chosen temperature (F).
 * This helper is intentionally small; RecipeAdapterService can do richer
 * conflict explanations, prompts, etc.
 *
 * @param {object} profile normalized profile
 * @param {object} q
 * @param {string} q.proteinCategory
 * @param {string=} q.cutTag
 * @param {number} tempF
 * @returns {{ tempF: number, raised: boolean, minimumF: number, basis: string }}
 */
function enforceSafetyMinimum(profile, q, tempF) {
  const mode = profile?.rules?.safetyMode || "enforce_minimums";
  if (mode === "off") {
    return {
      tempF: round1(clampNumber(tempF, 32, 450)),
      raised: false,
      minimumF: 0,
      basis: "off",
    };
  }

  const p =
    q?.proteinCategory && PROTEIN_CATEGORIES.includes(q.proteinCategory)
      ? q.proteinCategory
      : "unknown";
  const isGround = q?.cutTag === "ground";

  const mins = profile?.rules?.baselineMinimums;
  const minF = isGround ? mins?.groundF?.[p] : mins?.wholeCutsF?.[p];

  const minimumF = round1(clampNumber(minF ?? (isGround ? 160 : 145), 32, 450));
  const desired = round1(clampNumber(tempF, 32, 450));

  if (desired == null) {
    return {
      tempF: minimumF,
      raised: true,
      minimumF,
      basis: isGround ? "ground" : "whole",
    };
  }

  if (desired < minimumF) {
    return {
      tempF: minimumF,
      raised: true,
      minimumF,
      basis: isGround ? "ground" : "whole",
    };
  }

  return {
    tempF: desired,
    raised: false,
    minimumF,
    basis: isGround ? "ground" : "whole",
  };
}

/* -------------------------------------------------------------------------- */
/* Exports                                                                     */
/* -------------------------------------------------------------------------- */

export {
  // Schema
  DONENESS_PROFILE_SCHEMA,
  SCHEMA_ID,

  // Enums (useful for UI dropdowns)
  TEMP_UNITS,
  TIME_UNITS,
  SAFETY_MODES,
  DONENESS_LEVELS,
  PROTEIN_CATEGORIES,
  COOK_METHODS,
  CUT_TAGS,

  // Defaults + normalization + validation
  createDefaultDonenessProfile,
  normalizeDonenessProfile,
  validateDonenessProfile,
  assertValidDonenessProfile,

  // Convenience resolution helpers
  resolveDonenessTarget,
  enforceSafetyMinimum,

  // Internal converters (exported for engines/UI if needed)
  cToF,
  fToC,
  normalizeTempToF,
  normalizeTimeSec,
};

// ✅ FIX: provide a default export so `export { default as donenessProfileSchema } ...` works.
// Keep named exports unchanged.
export default DONENESS_PROFILE_SCHEMA;
