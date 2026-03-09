// File: C:\Users\larho\suka-smart-assistant\src\libraries\GardenPlanTemplates.js
/**
 * GardenPlanTemplates (SSA)
 * -----------------------------------------------------------------------------
 * A curated, low-AI, deterministic library of garden planning templates
 * that your planners/session engines can reuse.
 *
 * Design goals
 *  - Offline-first & deterministic: pure JS data, no external calls
 *  - “Web of meaning” ready: templates reference method/task ids that can be
 *    mapped by your lexicons (gardening.lexicon.json) or method catalogs
 *  - Human-friendly + machine-friendly: each template includes:
 *      • id, name, description
 *      • seasonality tags
 *      • zones/bed assumptions
 *      • crops & rotations
 *      • tasks (blueprint-ready) with durations, dependencies, and tools
 *      • supply hints (for inventory / storehouse)
 *
 * How to use
 *  - import { GardenPlanTemplates, getGardenPlanTemplate, listGardenPlanTemplates } from "@/libraries/GardenPlanTemplates";
 *  - In UI: show cards from listGardenPlanTemplates({ climateTag, season, difficulty })
 *  - In engines: use template.tasks to build a session blueprint
 *
 * Notes
 *  - This file deliberately avoids "perfect agronomy" for every region; instead,
 *    it provides sensible starter frameworks that users can customize.
 *  - You can extend with region packs later (e.g., "USDA 7b", "Gulf Coast", etc.).
 */

const SOURCE = "libraries.GardenPlanTemplates";

/* -----------------------------------------------------------------------------
 * Helpers
 * -------------------------------------------------------------------------- */

const safeArr = (x) => (Array.isArray(x) ? x : []);
const safeObj = (x) =>
  x && typeof x === "object" && !Array.isArray(x) ? x : {};
const keyOf = (s) =>
  String(s || "")
    .trim()
    .toLowerCase()
    .replace(/[^\w]+/g, "_")
    .replace(/^_+|_+$/g, "");

const minutes = (n) => Math.max(0, Math.round(Number(n) || 0));

function deepFreeze(obj) {
  if (!obj || typeof obj !== "object") return obj;
  Object.freeze(obj);
  Object.getOwnPropertyNames(obj).forEach((p) => {
    if (
      obj[p] &&
      (typeof obj[p] === "object" || typeof obj[p] === "function") &&
      !Object.isFrozen(obj[p])
    ) {
      deepFreeze(obj[p]);
    }
  });
  return obj;
}

/* -----------------------------------------------------------------------------
 * Canonical task “method” keys (map via lexicons / catalogs)
 * -------------------------------------------------------------------------- */

export const GARDEN_METHOD_KEYS = deepFreeze({
  // Planning / mapping
  BED_MAP: "garden.bed_map",
  CROP_PLAN: "garden.crop_plan",
  SEED_START_PLAN: "garden.seed_start_plan",
  ROTATION_PLAN: "garden.rotation_plan",
  SUCCESSION_PLAN: "garden.succession_plan",

  // Bed prep
  CLEAR_BED: "garden.clear_bed",
  WEED: "garden.weed",
  MULCH: "garden.mulch",
  AMEND_SOIL: "garden.amend_soil",
  BROADFORK: "garden.broadfork",
  RAKE_LEVEL: "garden.rake_level",
  ADD_COMPOST: "garden.add_compost",
  ADD_MANURE: "garden.add_manure",
  ADD_LIME: "garden.add_lime",
  ADD_BIOCHAR: "garden.add_biochar",

  // Planting / propagation
  START_SEEDS_INDOORS: "garden.start_seeds_indoors",
  HARDEN_OFF: "garden.harden_off",
  TRANSPLANT: "garden.transplant",
  DIRECT_SOW: "garden.direct_sow",
  THIN_SEEDLINGS: "garden.thin_seedlings",
  STAKE_TRELLIS: "garden.stake_trellis",

  // Water / irrigation
  SETUP_DRIP: "garden.setup_drip",
  WATER_DEEP: "garden.water_deep",
  WATER_LIGHT: "garden.water_light",
  CHECK_MOISTURE: "garden.check_moisture",

  // Protection / pest
  ROW_COVER: "garden.row_cover",
  INSECT_NETTING: "garden.insect_netting",
  HANDPICK_PESTS: "garden.handpick_pests",
  SPRAY_SOAP: "garden.spray_soap",
  APPLY_NEEM: "garden.apply_neem",
  APPLY_BT: "garden.apply_bt",
  SLUG_TRAPS: "garden.slug_traps",

  // Feeding / maintenance
  SIDE_DRESS: "garden.side_dress",
  FOLIAR_FEED: "garden.foliar_feed",
  PRUNE: "garden.prune",
  PINCH: "garden.pinch",
  TRAIN_VINES: "garden.train_vines",

  // Harvest / post-harvest
  HARVEST: "garden.harvest",
  WASH_SORT: "garden.wash_sort",
  STORE: "garden.store",
  SEED_SAVE: "garden.seed_save",
  COMPOST_SCRAPS: "garden.compost_scraps",

  // Cleanup / overwinter
  PULL_ANNUALS: "garden.pull_annuals",
  COVER_CROP: "garden.cover_crop",
  WINTERIZE_IRRIGATION: "garden.winterize_irrigation",
  TOOL_CLEAN: "garden.tool_clean",
});

/* -----------------------------------------------------------------------------
 * Tool hints (pure hints; inventory module can map)
 * -------------------------------------------------------------------------- */

export const GARDEN_TOOL_HINTS = deepFreeze({
  BASIC: [
    "gloves",
    "hand_trowel",
    "spade",
    "rake",
    "hoe",
    "pruners",
    "watering_can_or_hose",
  ],
  SOIL: ["wheelbarrow", "shovel", "compost_fork", "broadfork", "soil_test_kit"],
  IRRIGATION: [
    "drip_line",
    "emitters",
    "hose_timer",
    "pressure_regulator",
    "filter",
  ],
  PROTECTION: [
    "row_cover_fabric",
    "hoops",
    "clips",
    "insect_netting",
    "stakes",
  ],
  TRELLIS: ["tomato_cages", "stakes", "twine", "trellis_netting"],
  HARVEST: ["harvest_basket", "knife", "scale", "labels", "wash_tub"],
});

/* -----------------------------------------------------------------------------
 * Supply hints
 * -------------------------------------------------------------------------- */

export const GARDEN_SUPPLY_HINTS = deepFreeze({
  soilAmendments: [
    "compost",
    "aged_manure",
    "worm_castings",
    "lime",
    "bone_meal",
    "blood_meal",
    "kelp_meal",
    "biochar",
  ],
  mulches: ["straw", "wood_chips", "leaf_mold", "cardboard"],
  pest: ["insecticidal_soap", "neem_oil", "bt", "diatomaceous_earth"],
  seeds: ["seed_trays", "potting_mix", "heat_mat", "grow_lights", "labels"],
});

/* -----------------------------------------------------------------------------
 * Template schema
 * -------------------------------------------------------------------------- */

/**
 * Template
 *  - id: string
 *  - name: string
 *  - description: string
 *  - tags: { season:[], climate:[], difficulty, style:[] }
 *  - assumptions: { beds, bedSize, irrigation, sun, notes }
 *  - cropSets: [{ id,name, crops:[...], notes }]
 *  - rotations: [{ year, beds:{ bedId:[cropGroupIds...] } }]
 *  - tasks: [{ id, methodKey, title, minutes, phase, dependsOn, tools, supplies, notes, cadence }]
 */

function tTask(partial) {
  const p = safeObj(partial);
  const id = p.id
    ? String(p.id)
    : keyOf(p.title || p.methodKey || `task_${Math.random()}`);
  return {
    id,
    methodKey: String(p.methodKey || ""),
    title: String(p.title || ""),
    minutes: minutes(p.minutes),
    phase: String(p.phase || "plan"), // plan|prep|plant|maintain|harvest|close
    dependsOn: safeArr(p.dependsOn).map(String),
    tools: safeArr(p.tools).map(String),
    supplies: safeArr(p.supplies).map(String),
    cadence: p.cadence ? safeObj(p.cadence) : null, // { freq:"weekly", interval:1 } etc.
    notes: p.notes != null ? String(p.notes) : "",
  };
}

/* -----------------------------------------------------------------------------
 * Core templates
 * -------------------------------------------------------------------------- */

const TEMPLATES = [
  /* -------------------------------------------------------------------------
   * 1) Starter Kitchen Garden (4 beds)
   * ---------------------------------------------------------------------- */
  {
    id: "starter_kitchen_garden_4beds",
    name: "Starter Kitchen Garden (4 Beds)",
    description:
      "A simple, high-yield kitchen garden built around greens, herbs, tomatoes/peppers, and roots. Designed for steady harvest and easy rotation.",
    tags: {
      season: ["spring", "summer", "fall"],
      climate: ["temperate", "warm_temperate"],
      difficulty: "beginner",
      style: ["raised_beds", "kitchen_garden"],
    },
    assumptions: {
      beds: 4,
      bedSize: "4x8",
      irrigation: "hose_or_drip",
      sun: "6+ hours",
      notes:
        "Best for households wanting consistent meal-support crops. Rotation is simplified; customize to your calendar and region.",
    },
    cropSets: [
      {
        id: "greens_herbs",
        name: "Greens & Herbs",
        crops: [
          { cropId: "lettuce", spacing: "6-8in", succession: true },
          { cropId: "spinach", spacing: "4-6in", succession: true },
          { cropId: "kale", spacing: "12-18in", succession: false },
          { cropId: "basil", spacing: "10-12in", succession: false },
          { cropId: "cilantro", spacing: "4-6in", succession: true },
          { cropId: "parsley", spacing: "8-10in", succession: false },
        ],
        notes: "Succession sow fast greens every 2–3 weeks in-season.",
      },
      {
        id: "fruiting",
        name: "Fruiting Crops",
        crops: [
          { cropId: "tomato", spacing: "18-24in", trellis: true },
          { cropId: "pepper", spacing: "12-18in", trellis: "optional" },
          { cropId: "cucumber", spacing: "12in", trellis: true },
        ],
        notes: "Prioritize trellising and consistent watering for fruit set.",
      },
      {
        id: "roots_alliums",
        name: "Roots & Alliums",
        crops: [
          { cropId: "carrot", spacing: "2-3in", succession: true },
          { cropId: "beet", spacing: "4in", succession: true },
          { cropId: "onion", spacing: "4-6in", succession: false },
          { cropId: "garlic", spacing: "6in", season: "fall_plant" },
        ],
        notes: "Garlic is typically planted in fall and harvested next summer.",
      },
      {
        id: "legumes_brassicas",
        name: "Legumes & Brassicas",
        crops: [
          { cropId: "green_beans", spacing: "4-6in", trellis: "optional" },
          { cropId: "peas", spacing: "2-3in", trellis: true, season: "cool" },
          { cropId: "broccoli", spacing: "18in", season: "cool" },
          { cropId: "cabbage", spacing: "18in", season: "cool" },
        ],
        notes:
          "Cool season crops prefer spring/fall; adjust timing by climate.",
      },
    ],
    rotations: [
      {
        year: 1,
        beds: {
          bed1: ["greens_herbs"],
          bed2: ["fruiting"],
          bed3: ["roots_alliums"],
          bed4: ["legumes_brassicas"],
        },
      },
      {
        year: 2,
        beds: {
          bed1: ["fruiting"],
          bed2: ["roots_alliums"],
          bed3: ["legumes_brassicas"],
          bed4: ["greens_herbs"],
        },
      },
    ],
    tasks: [
      tTask({
        methodKey: GARDEN_METHOD_KEYS.BED_MAP,
        title: "Map beds and assign crop sets",
        minutes: 20,
        phase: "plan",
        tools: [],
        supplies: [],
        notes: "Label beds Bed1–Bed4; choose which crop set goes where.",
      }),
      tTask({
        methodKey: GARDEN_METHOD_KEYS.CROP_PLAN,
        title: "Create crop plan + succession schedule",
        minutes: 30,
        phase: "plan",
        tools: [],
        supplies: [],
        notes: "Write down sowing dates and expected harvest windows.",
      }),
      tTask({
        methodKey: GARDEN_METHOD_KEYS.CLEAR_BED,
        title: "Clear beds and remove debris",
        minutes: 30,
        phase: "prep",
        tools: GARDEN_TOOL_HINTS.BASIC,
        supplies: [],
      }),
      tTask({
        methodKey: GARDEN_METHOD_KEYS.ADD_COMPOST,
        title: "Add compost and light soil amendments",
        minutes: 45,
        phase: "prep",
        tools: [...GARDEN_TOOL_HINTS.SOIL],
        supplies: ["compost", "aged_manure (optional)"],
        notes: "Topdress 1–2 inches compost; lightly incorporate.",
      }),
      tTask({
        methodKey: GARDEN_METHOD_KEYS.RAKE_LEVEL,
        title: "Rake and level beds",
        minutes: 25,
        phase: "prep",
        tools: ["rake"],
      }),
      tTask({
        methodKey: GARDEN_METHOD_KEYS.START_SEEDS_INDOORS,
        title: "Start tomatoes/peppers indoors (if applicable)",
        minutes: 35,
        phase: "plant",
        tools: [],
        supplies: GARDEN_SUPPLY_HINTS.seeds,
        notes: "Start 6–10 weeks before transplant window.",
      }),
      tTask({
        methodKey: GARDEN_METHOD_KEYS.DIRECT_SOW,
        title: "Direct sow greens + roots (cool season)",
        minutes: 35,
        phase: "plant",
        tools: ["hand_trowel"],
        supplies: ["seeds: lettuce/spinach/carrots/beets"],
        notes: "Cover with light soil; keep moist until germination.",
      }),
      tTask({
        methodKey: GARDEN_METHOD_KEYS.TRANSPLANT,
        title: "Transplant tomatoes/peppers after frost (warm season)",
        minutes: 45,
        phase: "plant",
        dependsOn: [
          "start_tomatoes_peppers_indoors_if_applicable".replace(/ /g, "_"),
        ], // safe but not required
        tools: ["hand_trowel", "stakes"],
        supplies: ["transplants", "mulch (optional)"],
        notes: "Harden off before transplanting. Stake at planting time.",
      }),
      tTask({
        methodKey: GARDEN_METHOD_KEYS.STAKE_TRELLIS,
        title: "Install trellises/cages for fruiting crops",
        minutes: 30,
        phase: "plant",
        tools: GARDEN_TOOL_HINTS.TRELLIS,
        supplies: ["stakes", "twine", "cages/netting"],
      }),
      tTask({
        methodKey: GARDEN_METHOD_KEYS.CHECK_MOISTURE,
        title: "Check moisture and water as needed",
        minutes: 10,
        phase: "maintain",
        tools: ["moisture_check (finger test)"],
        cadence: { freq: "weekly", interval: 2 },
        notes: "Increase frequency during heat waves.",
      }),
      tTask({
        methodKey: GARDEN_METHOD_KEYS.WEED,
        title: "Weed beds (light pass)",
        minutes: 20,
        phase: "maintain",
        tools: ["hoe", "gloves"],
        cadence: { freq: "weekly", interval: 1 },
      }),
      tTask({
        methodKey: GARDEN_METHOD_KEYS.MULCH,
        title: "Mulch around plants",
        minutes: 25,
        phase: "maintain",
        tools: ["gloves"],
        supplies: ["straw/leaf_mold/wood_chips"],
        notes: "Mulch after seedlings establish; keep mulch off stems.",
      }),
      tTask({
        methodKey: GARDEN_METHOD_KEYS.HARVEST,
        title: "Harvest weekly for freshness",
        minutes: 25,
        phase: "harvest",
        tools: GARDEN_TOOL_HINTS.HARVEST,
        cadence: { freq: "weekly", interval: 1 },
        notes: "Pick greens early morning; harvest tomatoes when colored.",
      }),
      tTask({
        methodKey: GARDEN_METHOD_KEYS.WASH_SORT,
        title: "Wash, sort, and store harvest",
        minutes: 20,
        phase: "harvest",
        tools: ["wash_tub", "salad_spinner (optional)"],
        supplies: ["labels", "storage_bags/containers"],
      }),
      tTask({
        methodKey: GARDEN_METHOD_KEYS.COMPOST_SCRAPS,
        title: "Compost garden scraps",
        minutes: 10,
        phase: "close",
        tools: [],
        supplies: [],
      }),
    ],
  },

  /* -------------------------------------------------------------------------
   * 2) Salsa Garden (small footprint, high flavor)
   * ---------------------------------------------------------------------- */
  {
    id: "salsa_garden",
    name: "Salsa Garden (Flavor Pack)",
    description:
      "Focused plan for tomatoes, peppers, onions, cilantro, and optional tomatillos. Great for fresh salsa and preservation batches.",
    tags: {
      season: ["spring", "summer"],
      climate: ["warm_temperate", "hot"],
      difficulty: "beginner",
      style: ["raised_beds", "containers", "canning_ready"],
    },
    assumptions: {
      beds: 2,
      bedSize: "4x8",
      irrigation: "drip_preferred",
      sun: "6–10 hours",
      notes: "Scale up tomatoes/peppers to match canning volume targets.",
    },
    cropSets: [
      {
        id: "salsa_core",
        name: "Salsa Core",
        crops: [
          { cropId: "tomato", count: 6, spacing: "18-24in", trellis: true },
          { cropId: "jalapeno", count: 6, spacing: "12-18in" },
          { cropId: "onion", count: 30, spacing: "4-6in" },
          { cropId: "cilantro", succession: true, spacing: "4-6in" },
          { cropId: "garlic", season: "fall_plant", count: 20, spacing: "6in" },
        ],
        notes:
          "Stagger cilantro every 2 weeks. Garlic planted in fall if possible.",
      },
      {
        id: "salsa_optional",
        name: "Optional Adds",
        crops: [
          {
            cropId: "tomatillo",
            count: 2,
            spacing: "24in",
            trellis: "optional",
          },
          { cropId: "lime_basil", count: 2, spacing: "10-12in" },
        ],
        notes: "Tomatillos often need 2+ plants for pollination.",
      },
    ],
    rotations: [],
    tasks: [
      tTask({
        methodKey: GARDEN_METHOD_KEYS.CROP_PLAN,
        title: "Set salsa batch target (fresh + canning)",
        minutes: 20,
        phase: "plan",
        notes: "Decide how many jars you want and scale plants accordingly.",
      }),
      tTask({
        methodKey: GARDEN_METHOD_KEYS.START_SEEDS_INDOORS,
        title: "Start tomatoes/peppers indoors (or buy transplants)",
        minutes: 30,
        phase: "plant",
        supplies: [
          "seed_trays",
          "potting_mix",
          "labels",
          "tomato/pepper seeds",
        ],
      }),
      tTask({
        methodKey: GARDEN_METHOD_KEYS.ADD_COMPOST,
        title: "Compost + fertilizer base for heavy feeders",
        minutes: 40,
        phase: "prep",
        tools: GARDEN_TOOL_HINTS.SOIL,
        supplies: ["compost", "bone_meal (optional)", "kelp_meal (optional)"],
      }),
      tTask({
        methodKey: GARDEN_METHOD_KEYS.SETUP_DRIP,
        title: "Set up drip irrigation",
        minutes: 45,
        phase: "prep",
        tools: GARDEN_TOOL_HINTS.IRRIGATION,
        supplies: ["drip_line", "emitters", "timer"],
      }),
      tTask({
        methodKey: GARDEN_METHOD_KEYS.TRANSPLANT,
        title: "Transplant tomatoes + peppers",
        minutes: 45,
        phase: "plant",
        tools: ["hand_trowel", "stakes"],
      }),
      tTask({
        methodKey: GARDEN_METHOD_KEYS.DIRECT_SOW,
        title: "Direct sow cilantro + plant onions",
        minutes: 30,
        phase: "plant",
        tools: ["hand_trowel"],
      }),
      tTask({
        methodKey: GARDEN_METHOD_KEYS.STAKE_TRELLIS,
        title: "Install cages/trellis (tomatoes)",
        minutes: 25,
        phase: "plant",
        tools: GARDEN_TOOL_HINTS.TRELLIS,
      }),
      tTask({
        methodKey: GARDEN_METHOD_KEYS.SIDE_DRESS,
        title: "Side-dress tomatoes mid-season",
        minutes: 20,
        phase: "maintain",
        cadence: { freq: "monthly", interval: 1 },
        supplies: ["compost", "balanced_fertilizer (optional)"],
      }),
      tTask({
        methodKey: GARDEN_METHOD_KEYS.HARVEST,
        title: "Harvest for salsa (weekly peak season)",
        minutes: 30,
        phase: "harvest",
        cadence: { freq: "weekly", interval: 1 },
      }),
      tTask({
        methodKey: GARDEN_METHOD_KEYS.SEED_SAVE,
        title: "Seed-save from best tomatoes/peppers (optional)",
        minutes: 25,
        phase: "close",
        notes:
          "Only seed-save from open-pollinated varieties if you want stable results.",
      }),
    ],
  },

  /* -------------------------------------------------------------------------
   * 3) Fall & Cool Season Garden (Brassicas + Roots)
   * ---------------------------------------------------------------------- */
  {
    id: "cool_season_fall_garden",
    name: "Cool Season Garden (Fall Focus)",
    description:
      "A fall-heavy plan featuring brassicas, roots, and greens using row cover. Great for extending harvest into cold weather.",
    tags: {
      season: ["fall", "spring"],
      climate: ["temperate", "cool"],
      difficulty: "intermediate",
      style: ["row_cover", "raised_beds", "season_extension"],
    },
    assumptions: {
      beds: 3,
      bedSize: "4x8",
      irrigation: "hose_or_drip",
      sun: "4–8 hours",
      notes:
        "Timing is key: start transplants earlier so they size up before cold hits.",
    },
    cropSets: [
      {
        id: "brassicas",
        name: "Brassicas",
        crops: [
          { cropId: "broccoli", spacing: "18in" },
          { cropId: "cabbage", spacing: "18in" },
          { cropId: "collards", spacing: "18in" },
          { cropId: "kale", spacing: "12-18in" },
        ],
        notes: "Protect with netting/row cover against cabbage moths.",
      },
      {
        id: "roots",
        name: "Roots",
        crops: [
          { cropId: "carrot", spacing: "2-3in", succession: true },
          { cropId: "beet", spacing: "4in", succession: true },
          { cropId: "radish", spacing: "2in", succession: true },
          { cropId: "turnip", spacing: "4-6in" },
        ],
      },
      {
        id: "greens",
        name: "Greens",
        crops: [
          { cropId: "spinach", spacing: "4-6in", succession: true },
          { cropId: "lettuce", spacing: "6-8in", succession: true },
          { cropId: "arugula", spacing: "4-6in", succession: true },
        ],
      },
    ],
    rotations: [],
    tasks: [
      tTask({
        methodKey: GARDEN_METHOD_KEYS.SEED_START_PLAN,
        title: "Plan transplant timing for fall brassicas",
        minutes: 25,
        phase: "plan",
        notes:
          "Start transplants 6–8 weeks before your expected cool-down date.",
      }),
      tTask({
        methodKey: GARDEN_METHOD_KEYS.START_SEEDS_INDOORS,
        title: "Start brassicas in trays",
        minutes: 35,
        phase: "plant",
        supplies: ["seed_trays", "potting_mix", "labels", "brassica seeds"],
      }),
      tTask({
        methodKey: GARDEN_METHOD_KEYS.ADD_COMPOST,
        title: "Refresh beds with compost",
        minutes: 35,
        phase: "prep",
        tools: GARDEN_TOOL_HINTS.SOIL,
        supplies: ["compost"],
      }),
      tTask({
        methodKey: GARDEN_METHOD_KEYS.TRANSPLANT,
        title: "Transplant brassicas",
        minutes: 45,
        phase: "plant",
        tools: ["hand_trowel"],
      }),
      tTask({
        methodKey: GARDEN_METHOD_KEYS.DIRECT_SOW,
        title: "Direct sow roots + greens",
        minutes: 35,
        phase: "plant",
        tools: ["hand_trowel", "rake"],
      }),
      tTask({
        methodKey: GARDEN_METHOD_KEYS.ROW_COVER,
        title: "Install row cover hoops + fabric",
        minutes: 40,
        phase: "maintain",
        tools: GARDEN_TOOL_HINTS.PROTECTION,
        supplies: ["row_cover_fabric", "hoops", "clips"],
      }),
      tTask({
        methodKey: GARDEN_METHOD_KEYS.INSECT_NETTING,
        title: "Install insect netting (early season pest pressure)",
        minutes: 30,
        phase: "maintain",
        supplies: ["insect_netting", "clips"],
      }),
      tTask({
        methodKey: GARDEN_METHOD_KEYS.HANDPICK_PESTS,
        title: "Scout and handpick pests",
        minutes: 15,
        phase: "maintain",
        cadence: { freq: "weekly", interval: 1 },
      }),
      tTask({
        methodKey: GARDEN_METHOD_KEYS.HARVEST,
        title: "Harvest greens + roots steadily",
        minutes: 25,
        phase: "harvest",
        cadence: { freq: "weekly", interval: 1 },
      }),
      tTask({
        methodKey: GARDEN_METHOD_KEYS.COVER_CROP,
        title: "Sow cover crop after beds clear (optional)",
        minutes: 30,
        phase: "close",
        supplies: ["cover_crop_seed (rye/clover/vetch)"],
      }),
    ],
  },

  /* -------------------------------------------------------------------------
   * 4) Container Garden (Balcony / Small Space)
   * ---------------------------------------------------------------------- */
  {
    id: "container_balcony_garden",
    name: "Container Garden (Balcony / Small Space)",
    description:
      "A compact plan using containers: herbs, greens, peppers, and dwarf tomatoes. Built for renters and minimal space.",
    tags: {
      season: ["spring", "summer", "fall"],
      climate: ["temperate", "warm_temperate", "hot"],
      difficulty: "beginner",
      style: ["containers", "small_space"],
    },
    assumptions: {
      beds: 0,
      bedSize: null,
      irrigation: "hand_water",
      sun: "4–8 hours",
      notes:
        "Use quality potting mix and consistent watering. Add a slow-release fertilizer.",
    },
    cropSets: [
      {
        id: "containers_core",
        name: "Container Core",
        crops: [
          { cropId: "basil", container: "1-2 gal", spacing: "single" },
          {
            cropId: "mint",
            container: "1-2 gal",
            spacing: "single",
            notes: "Keep mint isolated; it spreads.",
          },
          { cropId: "parsley", container: "1 gal", spacing: "single" },
          { cropId: "lettuce", container: "window_box", spacing: "dense" },
          { cropId: "spinach", container: "window_box", spacing: "dense" },
          { cropId: "pepper", container: "3-5 gal", spacing: "single" },
          {
            cropId: "dwarf_tomato",
            container: "5 gal",
            spacing: "single",
            trellis: true,
          },
        ],
      },
    ],
    rotations: [],
    tasks: [
      tTask({
        methodKey: GARDEN_METHOD_KEYS.CROP_PLAN,
        title: "Choose containers and crops",
        minutes: 20,
        phase: "plan",
        supplies: ["containers", "potting_mix", "slow_release_fertilizer"],
      }),
      tTask({
        methodKey: GARDEN_METHOD_KEYS.TRANSPLANT,
        title: "Pot up transplants into containers",
        minutes: 35,
        phase: "plant",
        tools: ["hand_trowel", "gloves"],
      }),
      tTask({
        methodKey: GARDEN_METHOD_KEYS.WATER_LIGHT,
        title: "Water containers (as needed)",
        minutes: 10,
        phase: "maintain",
        cadence: { freq: "weekly", interval: 1 }, // planner may override to daily in heat
        notes: "Containers dry quickly; check daily in hot weather.",
      }),
      tTask({
        methodKey: GARDEN_METHOD_KEYS.SIDE_DRESS,
        title: "Feed heavy feeders monthly",
        minutes: 10,
        phase: "maintain",
        cadence: { freq: "monthly", interval: 1 },
        supplies: ["liquid_fertilizer or compost tea (optional)"],
      }),
      tTask({
        methodKey: GARDEN_METHOD_KEYS.HARVEST,
        title: "Harvest herbs and greens regularly",
        minutes: 15,
        phase: "harvest",
        cadence: { freq: "weekly", interval: 1 },
      }),
    ],
  },

  /* -------------------------------------------------------------------------
   * 5) Preservation Garden (Canning/Freezing/Dehydrating Support)
   * ---------------------------------------------------------------------- */
  {
    id: "preservation_garden_bulk",
    name: "Preservation Garden (Bulk + Storehouse)",
    description:
      "A scaled garden plan to support preservation: tomatoes, peppers, beans, cucumbers, onions/garlic, and herbs. Built for batch processing.",
    tags: {
      season: ["spring", "summer", "fall"],
      climate: ["warm_temperate", "hot"],
      difficulty: "intermediate",
      style: ["bulk", "canning_ready", "raised_beds"],
    },
    assumptions: {
      beds: 8,
      bedSize: "4x10",
      irrigation: "drip_required",
      sun: "6–10 hours",
      notes:
        "Designed for households that want serious storehouse outputs. Scale by expected jar targets and freezer capacity.",
    },
    cropSets: [
      {
        id: "bulk_tomatoes",
        name: "Bulk Tomatoes (Sauce + Diced)",
        crops: [
          {
            cropId: "tomato_paste",
            count: 18,
            spacing: "18-24in",
            trellis: true,
          },
          {
            cropId: "tomato_slicer",
            count: 12,
            spacing: "18-24in",
            trellis: true,
          },
        ],
        notes: "Paste tomatoes for sauce; slicers for fresh + diced.",
      },
      {
        id: "bulk_peppers",
        name: "Peppers (Sweet + Hot)",
        crops: [
          { cropId: "bell_pepper", count: 18, spacing: "12-18in" },
          { cropId: "jalapeno", count: 12, spacing: "12-18in" },
        ],
      },
      {
        id: "bulk_beans",
        name: "Beans (Green + Dry)",
        crops: [
          {
            cropId: "green_beans",
            count: 2,
            spacing: "4-6in",
            trellis: "optional",
          },
          {
            cropId: "dry_beans",
            count: 2,
            spacing: "4-6in",
            trellis: "optional",
          },
        ],
        notes: "One bed can be dedicated to dry beans for long storage.",
      },
      {
        id: "bulk_cukes",
        name: "Cucumbers (Pickling)",
        crops: [
          {
            cropId: "pickling_cucumber",
            count: 10,
            spacing: "12in",
            trellis: true,
          },
        ],
      },
      {
        id: "alliums",
        name: "Onions + Garlic",
        crops: [
          { cropId: "onion", count: 120, spacing: "4-6in" },
          {
            cropId: "garlic",
            count: 120,
            spacing: "6in",
            season: "fall_plant",
          },
        ],
      },
      {
        id: "herbs_support",
        name: "Herbs for Flavor + Preservation",
        crops: [
          { cropId: "basil", count: 12, spacing: "10-12in" },
          { cropId: "oregano", count: 4, spacing: "12-18in" },
          { cropId: "thyme", count: 4, spacing: "12in" },
        ],
      },
    ],
    rotations: [],
    tasks: [
      tTask({
        methodKey: GARDEN_METHOD_KEYS.CROP_PLAN,
        title: "Set preservation output targets (jars/freezer)",
        minutes: 30,
        phase: "plan",
        notes: "Translate jar targets into plant counts and bed assignments.",
      }),
      tTask({
        methodKey: GARDEN_METHOD_KEYS.SETUP_DRIP,
        title: "Install drip irrigation (mandatory for bulk plan)",
        minutes: 90,
        phase: "prep",
        tools: GARDEN_TOOL_HINTS.IRRIGATION,
      }),
      tTask({
        methodKey: GARDEN_METHOD_KEYS.ADD_COMPOST,
        title: "Amend soil heavily for bulk beds",
        minutes: 90,
        phase: "prep",
        tools: GARDEN_TOOL_HINTS.SOIL,
        supplies: ["compost", "aged_manure (optional)", "kelp_meal (optional)"],
      }),
      tTask({
        methodKey: GARDEN_METHOD_KEYS.STAKE_TRELLIS,
        title: "Install trellis systems for tomatoes/cukes",
        minutes: 60,
        phase: "plant",
        tools: GARDEN_TOOL_HINTS.TRELLIS,
      }),
      tTask({
        methodKey: GARDEN_METHOD_KEYS.TRANSPLANT,
        title: "Transplant tomatoes/peppers (staggered)",
        minutes: 75,
        phase: "plant",
        notes: "Stagger plantings by 1–2 weeks to spread harvest workload.",
      }),
      tTask({
        methodKey: GARDEN_METHOD_KEYS.DIRECT_SOW,
        title: "Direct sow beans (multiple rounds)",
        minutes: 45,
        phase: "plant",
        cadence: { freq: "monthly", interval: 1 },
      }),
      tTask({
        methodKey: GARDEN_METHOD_KEYS.HARVEST,
        title: "Harvest for preservation batches",
        minutes: 60,
        phase: "harvest",
        cadence: { freq: "weekly", interval: 1 },
        notes:
          "Plan harvest days around your batch cooking/preservation schedule.",
      }),
      tTask({
        methodKey: GARDEN_METHOD_KEYS.WASH_SORT,
        title: "Sort harvest into: fresh / preserve / compost",
        minutes: 30,
        phase: "harvest",
        supplies: ["labels", "bins"],
      }),
      tTask({
        methodKey: GARDEN_METHOD_KEYS.SEED_SAVE,
        title: "Save seed from best performers (optional)",
        minutes: 45,
        phase: "close",
      }),
    ],
  },
];

const FrozenTemplates = deepFreeze(TEMPLATES);

/* -----------------------------------------------------------------------------
 * Public selectors / API
 * -------------------------------------------------------------------------- */

/**
 * Return all templates (frozen).
 */
export function listGardenPlanTemplates(filters = {}) {
  const f = safeObj(filters);
  const season = f.season ? keyOf(f.season) : null;
  const climate = f.climate ? keyOf(f.climate) : null;
  const difficulty = f.difficulty ? keyOf(f.difficulty) : null;
  const style = f.style ? keyOf(f.style) : null;

  return FrozenTemplates.filter((t) => {
    const tags = safeObj(t.tags);
    if (season && !safeArr(tags.season).map(keyOf).includes(season))
      return false;
    if (climate && !safeArr(tags.climate).map(keyOf).includes(climate))
      return false;
    if (difficulty && keyOf(tags.difficulty) !== difficulty) return false;
    if (style && !safeArr(tags.style).map(keyOf).includes(style)) return false;
    return true;
  });
}

/**
 * Get a template by id (or null).
 */
export function getGardenPlanTemplate(id) {
  const key = keyOf(id);
  return FrozenTemplates.find((t) => keyOf(t.id) === key) || null;
}

/**
 * Return a "session blueprint-like" task list from a template.
 * (Keeps this library UI/engine friendly without coupling to your blueprint builder.)
 */
export function getGardenPlanTasks(id, options = {}) {
  const tpl = getGardenPlanTemplate(id);
  if (!tpl) return [];
  const opts = safeObj(options);

  // Optional: filter by phase
  const phase = opts.phase ? String(opts.phase) : null;
  let tasks = safeArr(tpl.tasks);

  if (phase) tasks = tasks.filter((x) => String(x.phase) === phase);

  // Optional: include only enabled tools/supplies?
  // (We keep as-is; inventory/tools resolver can decide.)
  return tasks;
}

/**
 * Minimal "card" summaries for UI selection.
 */
export function getGardenPlanCards(filters = {}) {
  return listGardenPlanTemplates(filters).map((t) => ({
    id: t.id,
    name: t.name,
    description: t.description,
    tags: t.tags,
    assumptions: t.assumptions,
    cropSetCount: safeArr(t.cropSets).length,
    taskCount: safeArr(t.tasks).length,
    source: SOURCE,
  }));
}

/**
 * Export the frozen library as default.
 */
export const GardenPlanTemplates = FrozenTemplates;

export default GardenPlanTemplates;
