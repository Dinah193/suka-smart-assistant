/* eslint-disable no-console */
// C:\Users\larho\suka-smart-assistant\src\features\recipes\contracts\kitchen.capabilities.schema.js
//
// SSA • Kitchen Capabilities Schema
// -----------------------------------------------------------------------------
// Purpose:
//   Describes what a household kitchen can actually do (appliances, tools,
//   heat sources, containers, measurement tools, constraints like smoke/fuel,
//   and skill/comfort toggles). RecipeAdapterService uses this to:
//     - adapt imported/manual recipes to on-hand equipment
//     - choose feasible methods (e.g., bake vs air-fry vs stovetop)
//     - suggest tool substitutions (via ToolSubstitutionRules.catalog)
//     - adjust steps (“use cast iron skillet” -> “use stainless pan”)
//     - avoid impossible instructions (no oven, no blender, etc.)
//
// Design goals:
//   - Deterministic, explainable adaptation
//   - Browser-safe (no Node-only deps)
//   - Strong JSON Schema validation (AJV-ready)
//   - Forward-compatible versioning + normalized shapes
//
// Notes:
//   - This schema models "capabilities", not inventory quantities.
//   - SSA engines should treat unknown capabilities conservatively.
//
// Expected usage:
//   import {
//     KITCHEN_CAPABILITIES_SCHEMA,
//     createDefaultKitchenCapabilities,
//     normalizeKitchenCapabilities,
//     validateKitchenCapabilities,
//     assertValidKitchenCapabilities,
//     hasCapability,
//     listCapabilities,
//   } from "@/features/recipes/contracts/kitchen.capabilities.schema";

const SCHEMA_ID = "ssa://schemas/recipes/kitchen-capabilities.schema.json#v1";

const NOW_ISO = () => new Date().toISOString();

/* -------------------------------------------------------------------------- */
/* Enumerations                                                                */
/* -------------------------------------------------------------------------- */

const POWER_SOURCES = [
  "electric",
  "gas",
  "propane",
  "wood",
  "charcoal",
  "solar",
  "none",
];

const HEAT_SOURCES = [
  "stove_top",
  "oven",
  "convection_oven",
  "toaster_oven",
  "air_fryer",
  "microwave",
  "grill_gas",
  "grill_charcoal",
  "smoker",
  "open_fire",
  "wood_stove",
  "induction_burner",
  "electric_hotplate",
];

const APPLIANCES = [
  "standard_oven",
  "convection_oven",
  "toaster_oven",
  "air_fryer",
  "microwave",
  "slow_cooker",
  "pressure_cooker_electric", // e.g., Instant Pot
  "pressure_cooker_stovetop",
  "rice_cooker",
  "bread_machine",
  "stand_mixer",
  "hand_mixer",
  "blender",
  "immersion_blender",
  "food_processor",
  "coffee_grinder",
  "grain_mill",
  "dehydrator",
  "vacuum_sealer",
  "sous_vide_circulator",
  "thermomix_style_multicooker",
  "ice_cream_maker",
  "waffle_iron",
  "griddle_electric",
  "deep_fryer",
];

const COOKWARE = [
  "sheet_pan",
  "roasting_pan",
  "casserole_dish",
  "dutch_oven",
  "stock_pot",
  "sauce_pan",
  "saute_pan",
  "skillet_cast_iron",
  "skillet_stainless",
  "skillet_nonstick",
  "wok",
  "grill_pan",
  "baking_stone",
  "loaf_pan",
  "muffin_tin",
  "pie_dish",
  "springform_pan",
  "steamer_basket",
];

const UTENSILS = [
  "chef_knife",
  "paring_knife",
  "serrated_knife",
  "cutting_board",
  "tongs",
  "spatula",
  "whisk",
  "wooden_spoon",
  "ladle",
  "peeler",
  "grater",
  "microplane",
  "can_opener",
  "colander",
  "strainer_fine",
  "measuring_cups",
  "measuring_spoons",
  "kitchen_scale",
  "rolling_pin",
  "mortar_pestle",
  "garlic_press",
  "citrus_juicer",
  "pastry_brush",
  "instant_read_thermometer",
  "probe_thermometer",
  "oven_thermometer",
  "timer",
];

const CONTAINERS = [
  "mixing_bowls",
  "storage_containers",
  "mason_jars",
  "freezer_bags",
  "vacuum_bags",
  "fermentation_crocks",
  "fermentation_jars_airlock",
];

const SKILL_LEVELS = ["beginner", "intermediate", "advanced"];

const COOKING_METHODS = [
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

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function deepClone(obj) {
  return obj ? JSON.parse(JSON.stringify(obj)) : obj;
}

function isPlainObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
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

/* -------------------------------------------------------------------------- */
/* JSON Schema                                                                 */
/* -------------------------------------------------------------------------- */

const KITCHEN_CAPABILITIES_SCHEMA = {
  $id: SCHEMA_ID,
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "SSA Kitchen Capabilities",
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion",
    "id",
    "scope",
    "capabilities",
    "constraints",
    "meta",
  ],
  properties: {
    schemaVersion: {
      type: "integer",
      const: 1,
      description: "Schema version for migrations.",
    },

    id: {
      type: "string",
      minLength: 8,
      maxLength: 128,
      description: "Stable id (uuid-like).",
    },

    scope: {
      type: "object",
      additionalProperties: false,
      required: ["householdId"],
      properties: {
        householdId: { type: "string", minLength: 1, maxLength: 128 },
        userId: { type: ["string", "null"], default: null, maxLength: 128 },
        level: {
          type: "string",
          enum: ["household_default", "user_override"],
          default: "household_default",
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
          else: { properties: { userId: { type: ["null"] } } },
        },
      ],
    },

    capabilities: {
      type: "object",
      additionalProperties: false,
      required: [
        "heat",
        "appliances",
        "cookware",
        "utensils",
        "containers",
        "measurements",
        "methods",
        "preferences",
      ],
      properties: {
        heat: {
          type: "object",
          additionalProperties: false,
          required: [
            "availableSources",
            "primaryPower",
            "secondaryPower",
            "burners",
            "oven",
          ],
          properties: {
            availableSources: {
              type: "array",
              items: { type: "string", enum: HEAT_SOURCES },
              uniqueItems: true,
              default: ["stove_top", "oven", "microwave"],
            },
            primaryPower: {
              type: "string",
              enum: POWER_SOURCES,
              default: "electric",
            },
            secondaryPower: {
              type: "string",
              enum: POWER_SOURCES,
              default: "none",
            },

            burners: {
              type: "object",
              additionalProperties: false,
              required: ["count", "supportsInduction"],
              properties: {
                count: { type: "integer", minimum: 0, maximum: 12, default: 4 },
                supportsInduction: { type: "boolean", default: false },
              },
            },

            oven: {
              type: "object",
              additionalProperties: false,
              required: ["hasOven", "hasConvection", "maxTempF"],
              properties: {
                hasOven: { type: "boolean", default: true },
                hasConvection: { type: "boolean", default: false },
                maxTempF: {
                  type: "number",
                  minimum: 200,
                  maximum: 650,
                  default: 500,
                },
              },
            },
          },
        },

        appliances: {
          type: "object",
          description: "Appliances present and usable.",
          additionalProperties: false,
          required: ["present", "notes"],
          properties: {
            present: {
              type: "array",
              items: { type: "string", enum: APPLIANCES },
              uniqueItems: true,
              default: ["standard_oven", "microwave"],
            },
            notes: { type: "string", default: "", maxLength: 4000 },
          },
        },

        cookware: {
          type: "object",
          additionalProperties: false,
          required: ["present", "sizes"],
          properties: {
            present: {
              type: "array",
              items: { type: "string", enum: COOKWARE },
              uniqueItems: true,
              default: [
                "sheet_pan",
                "stock_pot",
                "sauce_pan",
                "skillet_stainless",
              ],
            },
            sizes: {
              type: "object",
              additionalProperties: false,
              default: {},
              properties: {
                skilletInches: {
                  type: "array",
                  items: { type: "number", minimum: 6, maximum: 18 },
                  uniqueItems: true,
                  default: [10, 12],
                },
                saucePanQuarts: {
                  type: "array",
                  items: { type: "number", minimum: 0.5, maximum: 12 },
                  uniqueItems: true,
                  default: [2, 4],
                },
                stockPotQuarts: {
                  type: "array",
                  items: { type: "number", minimum: 2, maximum: 32 },
                  uniqueItems: true,
                  default: [8],
                },
              },
            },
          },
        },

        utensils: {
          type: "object",
          additionalProperties: false,
          required: ["present"],
          properties: {
            present: {
              type: "array",
              items: { type: "string", enum: UTENSILS },
              uniqueItems: true,
              default: [
                "chef_knife",
                "cutting_board",
                "tongs",
                "spatula",
                "wooden_spoon",
                "measuring_cups",
                "measuring_spoons",
                "timer",
              ],
            },
          },
        },

        containers: {
          type: "object",
          additionalProperties: false,
          required: ["present"],
          properties: {
            present: {
              type: "array",
              items: { type: "string", enum: CONTAINERS },
              uniqueItems: true,
              default: ["mixing_bowls", "storage_containers", "freezer_bags"],
            },
          },
        },

        measurements: {
          type: "object",
          additionalProperties: false,
          required: [
            "hasScale",
            "hasThermometer",
            "thermometerTypes",
            "preferredUnits",
          ],
          properties: {
            hasScale: { type: "boolean", default: false },
            hasThermometer: { type: "boolean", default: false },
            thermometerTypes: {
              type: "array",
              items: {
                type: "string",
                enum: ["instant_read", "probe", "oven", "infrared"],
              },
              uniqueItems: true,
              default: [],
            },
            preferredUnits: {
              type: "object",
              additionalProperties: false,
              required: ["temperature", "weight", "volume"],
              properties: {
                temperature: { type: "string", enum: ["F", "C"], default: "F" },
                weight: {
                  type: "string",
                  enum: ["oz", "lb", "g", "kg"],
                  default: "oz",
                },
                volume: {
                  type: "string",
                  enum: ["tsp", "tbsp", "cup", "ml", "l"],
                  default: "cup",
                },
              },
            },
          },
        },

        methods: {
          type: "object",
          additionalProperties: false,
          required: ["allowed", "preferred", "disallowed"],
          properties: {
            allowed: {
              type: "array",
              items: { type: "string", enum: COOKING_METHODS },
              uniqueItems: true,
              default: COOKING_METHODS.slice(),
              description: "Methods household can feasibly execute.",
            },
            preferred: {
              type: "array",
              items: { type: "string", enum: COOKING_METHODS },
              uniqueItems: true,
              default: [],
              description:
                "Methods to favor when multiple options exist (used in adaptation ranking).",
            },
            disallowed: {
              type: "array",
              items: { type: "string", enum: COOKING_METHODS },
              uniqueItems: true,
              default: [],
              description:
                "Methods to avoid even if technically possible (smoke, safety, etc.).",
            },
          },
        },

        preferences: {
          type: "object",
          additionalProperties: false,
          required: ["skillLevel", "comfort", "dietary", "timeBudget"],
          properties: {
            skillLevel: {
              type: "string",
              enum: SKILL_LEVELS,
              default: "intermediate",
            },

            comfort: {
              type: "object",
              additionalProperties: false,
              required: [
                "usesOpenFlame",
                "deepFryComfort",
                "pressureCookerComfort",
                "knifeSkillComfort",
              ],
              properties: {
                usesOpenFlame: { type: "boolean", default: true },
                deepFryComfort: {
                  type: "string",
                  enum: ["avoid", "ok", "prefer"],
                  default: "ok",
                },
                pressureCookerComfort: {
                  type: "string",
                  enum: ["avoid", "ok", "prefer"],
                  default: "ok",
                },
                knifeSkillComfort: {
                  type: "string",
                  enum: ["avoid_complex_cuts", "basic", "confident"],
                  default: "basic",
                },
              },
            },

            dietary: {
              type: "object",
              additionalProperties: false,
              default: {},
              properties: {
                avoidsAlcohol: { type: "boolean", default: false },
                avoidsPork: { type: "boolean", default: false },
                avoidsShellfish: { type: "boolean", default: false },
                glutenFree: { type: "boolean", default: false },
                dairyFree: { type: "boolean", default: false },
              },
            },

            timeBudget: {
              type: "object",
              additionalProperties: false,
              required: ["weeknightMaxMinutes", "weekendMaxMinutes"],
              properties: {
                weeknightMaxMinutes: {
                  type: "integer",
                  minimum: 5,
                  maximum: 600,
                  default: 60,
                },
                weekendMaxMinutes: {
                  type: "integer",
                  minimum: 5,
                  maximum: 1440,
                  default: 180,
                },
              },
            },
          },
        },
      },
    },

    constraints: {
      type: "object",
      additionalProperties: false,
      required: [
        "smokeSensitivity",
        "noiseSensitivity",
        "spaceConstraints",
        "powerConstraints",
        "fuelConstraints",
        "cleanupConstraints",
        "notes",
      ],
      properties: {
        smokeSensitivity: {
          type: "string",
          enum: ["low", "medium", "high"],
          default: "medium",
          description:
            "High = avoid heavy smoke methods indoors; influences method ranking.",
        },
        noiseSensitivity: {
          type: "string",
          enum: ["low", "medium", "high"],
          default: "low",
        },
        spaceConstraints: {
          type: "object",
          additionalProperties: false,
          required: ["counterSpace", "storageSpace"],
          properties: {
            counterSpace: {
              type: "string",
              enum: ["small", "medium", "large"],
              default: "medium",
            },
            storageSpace: {
              type: "string",
              enum: ["small", "medium", "large"],
              default: "medium",
            },
          },
        },
        powerConstraints: {
          type: "object",
          additionalProperties: false,
          required: ["maxWattage", "frequentOutages"],
          properties: {
            maxWattage: {
              type: "integer",
              minimum: 0,
              maximum: 20000,
              default: 0,
              description:
                "If set (>0), indicates max available kitchen wattage for appliances.",
            },
            frequentOutages: { type: "boolean", default: false },
          },
        },
        fuelConstraints: {
          type: "object",
          additionalProperties: false,
          required: ["hasPropane", "hasCharcoal", "hasWood"],
          properties: {
            hasPropane: { type: "boolean", default: false },
            hasCharcoal: { type: "boolean", default: false },
            hasWood: { type: "boolean", default: false },
          },
        },
        cleanupConstraints: {
          type: "object",
          additionalProperties: false,
          required: ["dishwasher", "prefersOnePot", "notes"],
          properties: {
            dishwasher: { type: "boolean", default: true },
            prefersOnePot: { type: "boolean", default: false },
            notes: { type: "string", default: "", maxLength: 2000 },
          },
        },
        notes: { type: "string", default: "", maxLength: 4000 },
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
          default: "features/recipes/contracts/kitchen.capabilities.schema",
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
};

/* -------------------------------------------------------------------------- */
/* Defaults                                                                    */
/* -------------------------------------------------------------------------- */

function createDefaultKitchenCapabilities(args = {}) {
  const id =
    typeof args.id === "string" && args.id
      ? args.id
      : `kitchen_${Math.random().toString(16).slice(2)}_${Date.now()}`;

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
    scope: { householdId, level, userId },

    capabilities: {
      heat: {
        availableSources: ["stove_top", "oven", "microwave"],
        primaryPower: "electric",
        secondaryPower: "none",
        burners: { count: 4, supportsInduction: false },
        oven: { hasOven: true, hasConvection: false, maxTempF: 500 },
      },

      appliances: {
        present: ["standard_oven", "microwave"],
        notes: "",
      },

      cookware: {
        present: ["sheet_pan", "stock_pot", "sauce_pan", "skillet_stainless"],
        sizes: {
          skilletInches: [10, 12],
          saucePanQuarts: [2, 4],
          stockPotQuarts: [8],
        },
      },

      utensils: {
        present: [
          "chef_knife",
          "cutting_board",
          "tongs",
          "spatula",
          "wooden_spoon",
          "measuring_cups",
          "measuring_spoons",
          "timer",
        ],
      },

      containers: {
        present: ["mixing_bowls", "storage_containers", "freezer_bags"],
      },

      measurements: {
        hasScale: false,
        hasThermometer: false,
        thermometerTypes: [],
        preferredUnits: {
          temperature: "F",
          weight: "oz",
          volume: "cup",
        },
      },

      methods: {
        allowed: COOKING_METHODS.slice(),
        preferred: [],
        disallowed: [],
      },

      preferences: {
        skillLevel: "intermediate",
        comfort: {
          usesOpenFlame: true,
          deepFryComfort: "ok",
          pressureCookerComfort: "ok",
          knifeSkillComfort: "basic",
        },
        dietary: {
          avoidsAlcohol: false,
          avoidsPork: false,
          avoidsShellfish: false,
          glutenFree: false,
          dairyFree: false,
        },
        timeBudget: {
          weeknightMaxMinutes: 60,
          weekendMaxMinutes: 180,
        },
      },
    },

    constraints: {
      smokeSensitivity: "medium",
      noiseSensitivity: "low",
      spaceConstraints: { counterSpace: "medium", storageSpace: "medium" },
      powerConstraints: { maxWattage: 0, frequentOutages: false },
      fuelConstraints: {
        hasPropane: false,
        hasCharcoal: false,
        hasWood: false,
      },
      cleanupConstraints: { dishwasher: true, prefersOnePot: false, notes: "" },
      notes: "",
    },

    meta: {
      createdAt,
      updatedAt: createdAt,
      source: "features/recipes/contracts/kitchen.capabilities.schema",
      tags: [],
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Normalization                                                               */
/* -------------------------------------------------------------------------- */

function normalizeKitchenCapabilities(raw, opts = {}) {
  const { quiet = true } = opts;
  const base = isPlainObject(raw) ? deepClone(raw) : {};
  const out =
    isPlainObject(base) && base.schemaVersion === 1
      ? base
      : createDefaultKitchenCapabilities({
          id: base.id,
          householdId: base?.scope?.householdId,
          userId: base?.scope?.userId,
          level: base?.scope?.level,
        });

  // Meta timestamps
  if (!out.meta) out.meta = {};
  if (!out.meta.createdAt) out.meta.createdAt = NOW_ISO();
  out.meta.updatedAt = NOW_ISO();

  // Scope sanity
  if (!out.scope)
    out.scope = {
      householdId: "household_default",
      level: "household_default",
      userId: null,
    };
  if (!out.scope.householdId) out.scope.householdId = "household_default";
  if (!["household_default", "user_override"].includes(out.scope.level))
    out.scope.level = "household_default";
  if (out.scope.level !== "user_override") out.scope.userId = null;

  if (!out.capabilities) out.capabilities = {};

  // Heat
  if (!out.capabilities.heat) out.capabilities.heat = {};
  out.capabilities.heat.availableSources = uniqEnum(
    out.capabilities.heat.availableSources,
    HEAT_SOURCES,
    ["stove_top", "oven", "microwave"]
  );
  out.capabilities.heat.primaryPower = enumOr(
    out.capabilities.heat.primaryPower,
    POWER_SOURCES,
    "electric"
  );
  out.capabilities.heat.secondaryPower = enumOr(
    out.capabilities.heat.secondaryPower,
    POWER_SOURCES,
    "none"
  );

  if (!out.capabilities.heat.burners) out.capabilities.heat.burners = {};
  out.capabilities.heat.burners.count = clampInt(
    out.capabilities.heat.burners.count ?? 4,
    0,
    12
  );
  out.capabilities.heat.burners.supportsInduction =
    !!out.capabilities.heat.burners.supportsInduction;

  if (!out.capabilities.heat.oven) out.capabilities.heat.oven = {};
  out.capabilities.heat.oven.hasOven = !!out.capabilities.heat.oven.hasOven;
  out.capabilities.heat.oven.hasConvection =
    !!out.capabilities.heat.oven.hasConvection;
  out.capabilities.heat.oven.maxTempF = clampNum(
    out.capabilities.heat.oven.maxTempF ?? 500,
    200,
    650
  );

  // Appliances
  if (!out.capabilities.appliances) out.capabilities.appliances = {};
  out.capabilities.appliances.present = uniqEnum(
    out.capabilities.appliances.present,
    APPLIANCES,
    ["standard_oven", "microwave"]
  );
  if (typeof out.capabilities.appliances.notes !== "string")
    out.capabilities.appliances.notes = "";

  // Cookware
  if (!out.capabilities.cookware) out.capabilities.cookware = {};
  out.capabilities.cookware.present = uniqEnum(
    out.capabilities.cookware.present,
    COOKWARE,
    ["sheet_pan", "stock_pot", "sauce_pan", "skillet_stainless"]
  );
  if (!out.capabilities.cookware.sizes) out.capabilities.cookware.sizes = {};
  out.capabilities.cookware.sizes.skilletInches = uniqNums(
    out.capabilities.cookware.sizes.skilletInches,
    6,
    18,
    [10, 12]
  );
  out.capabilities.cookware.sizes.saucePanQuarts = uniqNums(
    out.capabilities.cookware.sizes.saucePanQuarts,
    0.5,
    12,
    [2, 4]
  );
  out.capabilities.cookware.sizes.stockPotQuarts = uniqNums(
    out.capabilities.cookware.sizes.stockPotQuarts,
    2,
    32,
    [8]
  );

  // Utensils
  if (!out.capabilities.utensils) out.capabilities.utensils = {};
  out.capabilities.utensils.present = uniqEnum(
    out.capabilities.utensils.present,
    UTENSILS,
    [
      "chef_knife",
      "cutting_board",
      "tongs",
      "spatula",
      "wooden_spoon",
      "measuring_cups",
      "measuring_spoons",
      "timer",
    ]
  );

  // Containers
  if (!out.capabilities.containers) out.capabilities.containers = {};
  out.capabilities.containers.present = uniqEnum(
    out.capabilities.containers.present,
    CONTAINERS,
    ["mixing_bowls", "storage_containers", "freezer_bags"]
  );

  // Measurements
  if (!out.capabilities.measurements) out.capabilities.measurements = {};
  out.capabilities.measurements.hasScale =
    !!out.capabilities.measurements.hasScale;
  out.capabilities.measurements.hasThermometer =
    !!out.capabilities.measurements.hasThermometer;
  out.capabilities.measurements.thermometerTypes = uniqEnum(
    out.capabilities.measurements.thermometerTypes,
    ["instant_read", "probe", "oven", "infrared"],
    []
  );
  if (!out.capabilities.measurements.preferredUnits)
    out.capabilities.measurements.preferredUnits = {};
  out.capabilities.measurements.preferredUnits.temperature = enumOr(
    out.capabilities.measurements.preferredUnits.temperature,
    ["F", "C"],
    "F"
  );
  out.capabilities.measurements.preferredUnits.weight = enumOr(
    out.capabilities.measurements.preferredUnits.weight,
    ["oz", "lb", "g", "kg"],
    "oz"
  );
  out.capabilities.measurements.preferredUnits.volume = enumOr(
    out.capabilities.measurements.preferredUnits.volume,
    ["tsp", "tbsp", "cup", "ml", "l"],
    "cup"
  );

  // Methods
  if (!out.capabilities.methods) out.capabilities.methods = {};
  out.capabilities.methods.allowed = uniqEnum(
    out.capabilities.methods.allowed,
    COOKING_METHODS,
    COOKING_METHODS.slice()
  );
  out.capabilities.methods.preferred = uniqEnum(
    out.capabilities.methods.preferred,
    COOKING_METHODS,
    []
  );
  out.capabilities.methods.disallowed = uniqEnum(
    out.capabilities.methods.disallowed,
    COOKING_METHODS,
    []
  );

  // Ensure preferred/disallowed are subsets of allowed
  const allowedSet = new Set(out.capabilities.methods.allowed);
  out.capabilities.methods.preferred =
    out.capabilities.methods.preferred.filter((m) => allowedSet.has(m));
  out.capabilities.methods.disallowed =
    out.capabilities.methods.disallowed.filter((m) => allowedSet.has(m));

  // Preferences
  if (!out.capabilities.preferences) out.capabilities.preferences = {};
  out.capabilities.preferences.skillLevel = enumOr(
    out.capabilities.preferences.skillLevel,
    SKILL_LEVELS,
    "intermediate"
  );

  if (!out.capabilities.preferences.comfort)
    out.capabilities.preferences.comfort = {};
  out.capabilities.preferences.comfort.usesOpenFlame =
    !!out.capabilities.preferences.comfort.usesOpenFlame;
  out.capabilities.preferences.comfort.deepFryComfort = enumOr(
    out.capabilities.preferences.comfort.deepFryComfort,
    ["avoid", "ok", "prefer"],
    "ok"
  );
  out.capabilities.preferences.comfort.pressureCookerComfort = enumOr(
    out.capabilities.preferences.comfort.pressureCookerComfort,
    ["avoid", "ok", "prefer"],
    "ok"
  );
  out.capabilities.preferences.comfort.knifeSkillComfort = enumOr(
    out.capabilities.preferences.comfort.knifeSkillComfort,
    ["avoid_complex_cuts", "basic", "confident"],
    "basic"
  );

  if (!out.capabilities.preferences.dietary)
    out.capabilities.preferences.dietary = {};
  out.capabilities.preferences.dietary.avoidsAlcohol =
    !!out.capabilities.preferences.dietary.avoidsAlcohol;
  out.capabilities.preferences.dietary.avoidsPork =
    !!out.capabilities.preferences.dietary.avoidsPork;
  out.capabilities.preferences.dietary.avoidsShellfish =
    !!out.capabilities.preferences.dietary.avoidsShellfish;
  out.capabilities.preferences.dietary.glutenFree =
    !!out.capabilities.preferences.dietary.glutenFree;
  out.capabilities.preferences.dietary.dairyFree =
    !!out.capabilities.preferences.dietary.dairyFree;

  if (!out.capabilities.preferences.timeBudget)
    out.capabilities.preferences.timeBudget = {};
  out.capabilities.preferences.timeBudget.weeknightMaxMinutes = clampInt(
    out.capabilities.preferences.timeBudget.weeknightMaxMinutes ?? 60,
    5,
    600
  );
  out.capabilities.preferences.timeBudget.weekendMaxMinutes = clampInt(
    out.capabilities.preferences.timeBudget.weekendMaxMinutes ?? 180,
    5,
    1440
  );

  // Constraints
  if (!out.constraints) out.constraints = {};
  out.constraints.smokeSensitivity = enumOr(
    out.constraints.smokeSensitivity,
    ["low", "medium", "high"],
    "medium"
  );
  out.constraints.noiseSensitivity = enumOr(
    out.constraints.noiseSensitivity,
    ["low", "medium", "high"],
    "low"
  );

  if (!out.constraints.spaceConstraints) out.constraints.spaceConstraints = {};
  out.constraints.spaceConstraints.counterSpace = enumOr(
    out.constraints.spaceConstraints.counterSpace,
    ["small", "medium", "large"],
    "medium"
  );
  out.constraints.spaceConstraints.storageSpace = enumOr(
    out.constraints.spaceConstraints.storageSpace,
    ["small", "medium", "large"],
    "medium"
  );

  if (!out.constraints.powerConstraints) out.constraints.powerConstraints = {};
  out.constraints.powerConstraints.maxWattage = clampInt(
    out.constraints.powerConstraints.maxWattage ?? 0,
    0,
    20000
  );
  out.constraints.powerConstraints.frequentOutages =
    !!out.constraints.powerConstraints.frequentOutages;

  if (!out.constraints.fuelConstraints) out.constraints.fuelConstraints = {};
  out.constraints.fuelConstraints.hasPropane =
    !!out.constraints.fuelConstraints.hasPropane;
  out.constraints.fuelConstraints.hasCharcoal =
    !!out.constraints.fuelConstraints.hasCharcoal;
  out.constraints.fuelConstraints.hasWood =
    !!out.constraints.fuelConstraints.hasWood;

  if (!out.constraints.cleanupConstraints)
    out.constraints.cleanupConstraints = {};
  out.constraints.cleanupConstraints.dishwasher =
    !!out.constraints.cleanupConstraints.dishwasher;
  out.constraints.cleanupConstraints.prefersOnePot =
    !!out.constraints.cleanupConstraints.prefersOnePot;
  if (typeof out.constraints.cleanupConstraints.notes !== "string")
    out.constraints.cleanupConstraints.notes = "";

  if (typeof out.constraints.notes !== "string") out.constraints.notes = "";

  const vr = validateKitchenCapabilities(out);
  if (!vr.ok && !quiet) {
    console.warn(
      "[SSA][kitchen] normalize produced invalid capabilities:",
      vr.errors
    );
  }

  return out;
}

function enumOr(v, allowed, fallback) {
  return allowed.includes(v) ? v : fallback;
}

function uniqEnum(arr, allowed, fallbackArr) {
  const out = [];
  const seen = new Set();
  for (const v of Array.isArray(arr) ? arr : []) {
    if (typeof v !== "string") continue;
    const s = v.trim();
    if (!s) continue;
    if (!allowed.includes(s)) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  if (!out.length && Array.isArray(fallbackArr)) return fallbackArr.slice();
  return out;
}

function uniqNums(arr, min, max, fallbackArr) {
  const out = [];
  const seen = new Set();
  for (const v of Array.isArray(arr) ? arr : []) {
    const x = clampNum(v, min, max);
    if (x == null) continue;
    const key = String(x);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(x);
  }
  if (!out.length && Array.isArray(fallbackArr)) return fallbackArr.slice();
  return out;
}

/* -------------------------------------------------------------------------- */
/* Validation (AJV optional)                                                   */
/* -------------------------------------------------------------------------- */
/**
 * validateKitchenCapabilities
 * Browser-safe:
 *  - NO Node `require()` (Vite/Rollup build-safe)
 *  - If you want AJV validation, pass an Ajv instance from app code:
 *      validateKitchenCapabilities(doc, { ajv })
 *
 * @param {object} doc
 * @param {object=} opts
 * @param {any=} opts.ajv Ajv instance (optional)
 * @returns {{ ok: boolean, errors: Array<{path:string,message:string}> }}
 */
function validateKitchenCapabilities(doc, opts = {}) {
  const ajv = opts?.ajv;

  if (ajv && typeof ajv.compile === "function") {
    try {
      const validate = ajv.compile(KITCHEN_CAPABILITIES_SCHEMA);
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
      errors: [{ path: "", message: "KitchenCapabilities must be an object" }],
    };
  }
  if (doc.schemaVersion !== 1) {
    errors.push({ path: "/schemaVersion", message: "schemaVersion must be 1" });
  }
  if (typeof doc.id !== "string" || doc.id.length < 8) {
    errors.push({ path: "/id", message: "id must be a string (minLength 8)" });
  }
  if (
    !doc.scope ||
    typeof doc.scope.householdId !== "string" ||
    !doc.scope.householdId
  ) {
    errors.push({
      path: "/scope/householdId",
      message: "scope.householdId required",
    });
  }
  if (!doc.capabilities || !isPlainObject(doc.capabilities)) {
    errors.push({
      path: "/capabilities",
      message: "capabilities must be an object",
    });
  }
  return { ok: errors.length === 0, errors };
}

function assertValidKitchenCapabilities(doc, opts = {}) {
  const r = validateKitchenCapabilities(doc, opts);
  if (!r.ok) {
    const msg =
      "[SSA][kitchen] Invalid KitchenCapabilities: " +
      r.errors.map((e) => `${e.path}: ${e.message}`).join("; ");
    const err = new Error(msg);
    err.name = "KitchenCapabilitiesValidationError";
    err.details = r.errors;
    throw err;
  }
}

/* -------------------------------------------------------------------------- */
/* Capability queries (used by adapter + UI)                                   */
/* -------------------------------------------------------------------------- */

/**
 * hasCapability
 * @param {object} caps normalized kitchen capabilities
 * @param {object} q
 * @param {string=} q.heatSource one of HEAT_SOURCES
 * @param {string=} q.appliance one of APPLIANCES
 * @param {string=} q.cookware one of COOKWARE
 * @param {string=} q.utensil one of UTENSILS
 * @param {string=} q.container one of CONTAINERS
 * @param {string=} q.method one of COOKING_METHODS
 */
function hasCapability(caps, q = {}) {
  const c = caps?.capabilities;
  if (!c) return false;

  if (q.heatSource) {
    return (c.heat?.availableSources || []).includes(q.heatSource);
  }
  if (q.appliance) {
    return (c.appliances?.present || []).includes(q.appliance);
  }
  if (q.cookware) {
    return (c.cookware?.present || []).includes(q.cookware);
  }
  if (q.utensil) {
    return (c.utensils?.present || []).includes(q.utensil);
  }
  if (q.container) {
    return (c.containers?.present || []).includes(q.container);
  }
  if (q.method) {
    const allowed = c.methods?.allowed || [];
    const disallowed = new Set(c.methods?.disallowed || []);
    return allowed.includes(q.method) && !disallowed.has(q.method);
  }
  return false;
}

/**
 * listCapabilities
 * Returns a compact summary useful for UI badges, quick checks, etc.
 */
function listCapabilities(caps) {
  const c = caps?.capabilities || {};
  return {
    heatSources: (c.heat?.availableSources || []).slice(),
    appliances: (c.appliances?.present || []).slice(),
    cookware: (c.cookware?.present || []).slice(),
    utensils: (c.utensils?.present || []).slice(),
    containers: (c.containers?.present || []).slice(),
    methodsAllowed: (c.methods?.allowed || []).slice(),
    methodsPreferred: (c.methods?.preferred || []).slice(),
    methodsDisallowed: (c.methods?.disallowed || []).slice(),
    units: deepClone(c.measurements?.preferredUnits || {}),
    skillLevel: c.preferences?.skillLevel || "intermediate",
  };
}

/* -------------------------------------------------------------------------- */
/* Exports                                                                     */
/* -------------------------------------------------------------------------- */

export {
  // Schema
  KITCHEN_CAPABILITIES_SCHEMA,
  SCHEMA_ID,

  // Enums for UI
  POWER_SOURCES,
  HEAT_SOURCES,
  APPLIANCES,
  COOKWARE,
  UTENSILS,
  CONTAINERS,
  SKILL_LEVELS,
  COOKING_METHODS,

  // Defaults + normalize + validate
  createDefaultKitchenCapabilities,
  normalizeKitchenCapabilities,
  validateKitchenCapabilities,
  assertValidKitchenCapabilities,

  // Queries
  hasCapability,
  listCapabilities,
};

// ✅ FIX: provide a default export so `export { default as kitchenCapabilitiesSchema } ...` works.
export default KITCHEN_CAPABILITIES_SCHEMA;
