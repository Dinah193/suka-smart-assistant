// File: C:\Users\larho\suka-smart-assistant\src\libraries\CookPlanTemplates.js
/**
 * CookPlanTemplates (SSA)
 * -----------------------------------------------------------------------------
 * Deterministic, offline-first cooking plan templates designed to support:
 *  - meal planning rhythm (fixed-but-varied)
 *  - batch cooking sessions (multi-timer friendly)
 *  - leftovers-to-lunch logic (soup/sandwich + planned leftovers)
 *  - cuisine profiles (later) via tags + flavor families
 *  - storehouse + inventory planning (supplies + ingredients as hints)
 *
 * This is NOT a recipe library.
 * It is a "plan blueprint library" – repeatable cooking patterns.
 *
 * Each template includes:
 *  - id, name, description
 *  - tags: mealType, rhythmRole, difficulty, cuisineNeutral, equipment, dietModes
 *  - assumptions: household size, leftovers policy, equipment requirements
 *  - cadence: suggested schedule placement (weekly rhythm)
 *  - blocks: plan blocks (e.g., "Dinner", "Lunch Prep", "Preservation")
 *  - tasks: blueprint-ready tasks (methodKey aligned to lexicons/catalogs)
 *  - supplyHints: inventory hints for storehouse provisioning
 *
 * Integration notes
 *  - Your Session/BlueprintBuilder can consume tasks[] and blocks[] to build
 *    a Cooking Session blueprint.
 *  - Your Meal Planner can use cadence + constraints to select a template
 *    instead of "AI choosing meals".
 */

const SOURCE = "libraries.CookPlanTemplates";

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

function cTask(partial) {
  const p = safeObj(partial);
  const id =
    p.id ||
    keyOf(
      p.title || p.methodKey || `task_${Math.random().toString(16).slice(2)}`
    );
  return {
    id: String(id),
    methodKey: String(p.methodKey || ""),
    title: String(p.title || ""),
    minutes: minutes(p.minutes),
    phase: String(p.phase || "prep"), // plan|prep|cook|serve|cleanup|preserve
    dependsOn: safeArr(p.dependsOn).map(String),
    tools: safeArr(p.tools).map(String),
    supplies: safeArr(p.supplies).map(String),
    timers: safeArr(p.timers).map((t) => ({
      id: String(t?.id || uid("timer")),
      label: String(t?.label || "Timer"),
      minutes: minutes(t?.minutes),
      startsOn: t?.startsOn ? String(t.startsOn) : null, // taskId reference
      notes: t?.notes != null ? String(t.notes) : "",
    })),
    notes: p.notes != null ? String(p.notes) : "",
    cadence: p.cadence ? safeObj(p.cadence) : null, // { freq:"weekly", interval:1 }
    meta: p.meta ? safeObj(p.meta) : {},
  };
}

function uid(prefix = "cp") {
  return `${prefix}_${Math.random()
    .toString(16)
    .slice(2)}_${Date.now().toString(16)}`;
}

/* -----------------------------------------------------------------------------
 * Canonical cooking method keys (map via lexicons/catalogs)
 * -------------------------------------------------------------------------- */

export const COOK_METHOD_KEYS = deepFreeze({
  // Planning / staging
  PLAN_MENU: "cook.plan_menu",
  PLAN_LEFTOVERS: "cook.plan_leftovers",
  THAW: "cook.thaw",
  CLEAN_AS_YOU_GO: "cook.clean_as_you_go",

  // Prep
  MISE_EN_PLACE: "cook.mise_en_place",
  CHOP: "cook.chop",
  MARINATE: "cook.marinate",
  SEASON: "cook.season",
  PREHEAT: "cook.preheat",

  // Cooking methods
  ROAST: "cook.roast",
  BAKE: "cook.bake",
  GRILL: "cook.grill",
  SAUTE: "cook.saute",
  SIMMER: "cook.simmer",
  BOIL: "cook.boil",
  STEAM: "cook.steam",
  PRESSURE_COOK: "cook.pressure_cook",
  SLOW_COOK: "cook.slow_cook",
  FRY: "cook.fry",

  // Soup / stock
  STOCK: "cook.stock",
  SOUP: "cook.soup",

  // Sandwich / lunch
  SANDWICH: "cook.sandwich",
  WRAP: "cook.wrap",
  SALAD: "cook.salad",

  // Sides
  RICE: "cook.rice",
  GRAINS: "cook.grains",
  BREAD: "cook.bread",
  VEG_SIDE: "cook.veg_side",

  // Finish / service
  REST_MEAT: "cook.rest_meat",
  PLATE: "cook.plate",
  HOLD_WARM: "cook.hold_warm",

  // Cleanup / preservation
  CLEANUP: "cook.cleanup",
  PACKAGE_LEFTOVERS: "cook.package_leftovers",
  LABEL_DATE: "cook.label_date",
  FREEZE: "cook.freeze",
  FRIDGE: "cook.fridge",
});

/* -----------------------------------------------------------------------------
 * Equipment hints (inventory/tools resolver can map these)
 * -------------------------------------------------------------------------- */

export const COOK_TOOL_HINTS = deepFreeze({
  BASIC: [
    "knife",
    "cutting_board",
    "mixing_bowls",
    "measuring_tools",
    "sheet_pan",
    "skillet",
    "pot",
  ],
  OVEN: ["oven", "sheet_pan", "roasting_pan", "thermometer"],
  SOUP: ["large_pot", "ladle", "storage_containers"],
  PRESSURE: ["pressure_cooker (instant_pot)", "trivet", "silicone_seals"],
  SLOW: ["slow_cooker", "liner (optional)"],
  GRILL: ["grill", "tongs", "thermometer"],
  BREAD: [
    "mixing_bowl",
    "proofing_basket (optional)",
    "baking_stone (optional)",
  ],
  PACKING: [
    "containers",
    "freezer_bags",
    "labels",
    "marker",
    "scale (optional)",
  ],
});

/* -----------------------------------------------------------------------------
 * Supply hints (storehouse planning)
 * -------------------------------------------------------------------------- */

export const COOK_SUPPLY_HINTS = deepFreeze({
  staples: [
    "salt",
    "pepper",
    "garlic",
    "onion",
    "oil",
    "vinegar",
    "broth/stock",
    "tomato_products",
  ],
  grains: ["rice", "flour", "cornmeal", "pasta", "oats"],
  legumes: ["beans_dry", "beans_canned", "lentils"],
  freezer: ["freezer_bags", "labels", "foil", "parchment"],
  soups: ["bouillon", "broth_base", "noodles", "potatoes", "carrots", "celery"],
});

/* -----------------------------------------------------------------------------
 * Template schema
 * -------------------------------------------------------------------------- */
/**
 * Template
 *  - id, name, description
 *  - tags: mealType[], rhythmRole[], difficulty, dietModes[], equipment[]
 *  - assumptions: { portions, leftoversPolicy, notes }
 *  - cadence: { suggestedDays:[], window, anchors }
 *  - blocks: [{ id,name, role, notes }]
 *  - tasks: [cTask...]
 *  - supplyHints: { ingredients:[], tools:[], pantry:[] }
 */

/* -----------------------------------------------------------------------------
 * Templates
 * -------------------------------------------------------------------------- */

const TEMPLATES = [
  /* -------------------------------------------------------------------------
   * 1) Weeknight Sheet-Pan Dinner + Lunch Leftovers
   * ---------------------------------------------------------------------- */
  {
    id: "weeknight_sheetpan_dinner_leftovers",
    name: "Weeknight Sheet-Pan Dinner + Leftover Lunch",
    description:
      "A fast, low-dish dinner pattern: roast protein + veg on a sheet pan and intentionally create next-day lunch portions.",
    tags: {
      mealType: ["dinner", "lunch_prep"],
      rhythmRole: ["weeknight_anchor", "leftovers_engine"],
      difficulty: "beginner",
      cuisineNeutral: true,
      equipment: ["oven"],
      dietModes: ["balanced", "keto_friendly", "low_carb"],
    },
    assumptions: {
      portions: { dinner: 4, lunchLeftovers: 2 },
      leftoversPolicy: "package_next_day_lunch",
      notes:
        "Works with chicken, fish, beef, lamb, goat, or sausage. Swap veg by season.",
    },
    cadence: {
      suggestedDays: ["Mon", "Tue", "Wed", "Thu"],
      window: "60-90min",
      anchors: ["after_work", "school_night"],
    },
    blocks: [
      {
        id: "block_dinner",
        name: "Dinner",
        role: "main",
        notes: "Sheet-pan roast + quick side.",
      },
      {
        id: "block_lunch",
        name: "Lunch Prep",
        role: "leftovers",
        notes: "Package 2 portions.",
      },
    ],
    tasks: [
      cTask({
        methodKey: COOK_METHOD_KEYS.PLAN_MENU,
        title: "Select protein + veg combo",
        minutes: 5,
        phase: "plan",
        notes: "Choose 1 protein, 2 vegetables, and 1 optional sauce.",
      }),
      cTask({
        methodKey: COOK_METHOD_KEYS.PREHEAT,
        title: "Preheat oven",
        minutes: 5,
        phase: "prep",
        tools: COOK_TOOL_HINTS.OVEN,
        timers: [{ label: "Preheat", minutes: 10 }],
      }),
      cTask({
        methodKey: COOK_METHOD_KEYS.MISE_EN_PLACE,
        title: "Gather ingredients + set up sheet pan",
        minutes: 10,
        phase: "prep",
        tools: COOK_TOOL_HINTS.BASIC,
        supplies: ["parchment/foil (optional)"],
      }),
      cTask({
        methodKey: COOK_METHOD_KEYS.CHOP,
        title: "Chop vegetables",
        minutes: 12,
        phase: "prep",
        tools: ["knife", "cutting_board"],
      }),
      cTask({
        methodKey: COOK_METHOD_KEYS.SEASON,
        title: "Season protein + vegetables",
        minutes: 6,
        phase: "prep",
        supplies: COOK_SUPPLY_HINTS.staples,
        notes: "Oil + salt + spice blend. Add acid after roasting if desired.",
      }),
      cTask({
        methodKey: COOK_METHOD_KEYS.ROAST,
        title: "Roast sheet pan meal",
        minutes: 30,
        phase: "cook",
        tools: COOK_TOOL_HINTS.OVEN,
        timers: [{ label: "Roast", minutes: 25 }],
        notes: "Typical: 425°F; adjust time for protein thickness.",
      }),
      cTask({
        methodKey: COOK_METHOD_KEYS.REST_MEAT,
        title: "Rest protein briefly",
        minutes: 5,
        phase: "serve",
        timers: [{ label: "Rest", minutes: 5 }],
      }),
      cTask({
        methodKey: COOK_METHOD_KEYS.PLATE,
        title: "Serve dinner",
        minutes: 5,
        phase: "serve",
      }),
      cTask({
        methodKey: COOK_METHOD_KEYS.PACKAGE_LEFTOVERS,
        title: "Package 2 lunch portions from leftovers",
        minutes: 8,
        phase: "preserve",
        tools: COOK_TOOL_HINTS.PACKING,
        supplies: ["containers", "labels"],
      }),
      cTask({
        methodKey: COOK_METHOD_KEYS.CLEANUP,
        title: "Cleanup (sheet pan + prep area)",
        minutes: 12,
        phase: "cleanup",
        notes: "Soak pan immediately if needed.",
      }),
    ],
    supplyHints: {
      ingredients: [
        "protein_of_choice",
        "2_vegetables",
        "optional_sauce_or_dip",
      ],
      tools: COOK_TOOL_HINTS.OVEN,
      pantry: COOK_SUPPLY_HINTS.staples,
    },
  },

  /* -------------------------------------------------------------------------
   * 2) Soup Dinner + Soup & Sandwich Lunch Rhythm (No Overwhelm)
   * ---------------------------------------------------------------------- */
  {
    id: "soup_dinner_and_sandwich_lunch_rhythm",
    name: "Soup Dinner + Soup & Sandwich Lunch Rhythm",
    description:
      "A rhythm template: make hearty soup for dinner and intentionally reserve soup + bread components for lunch the next day (or day after).",
    tags: {
      mealType: ["dinner", "lunch"],
      rhythmRole: ["soup_night", "leftovers_engine"],
      difficulty: "beginner",
      cuisineNeutral: true,
      equipment: ["soup_pot"],
      dietModes: ["balanced", "keto_optional", "high_protein"],
    },
    assumptions: {
      portions: { dinner: 6, lunchLeftovers: 4 },
      leftoversPolicy: "reserve_soup_portions",
      notes:
        "This prevents overwhelm by using one soup cook to cover 2 meals. Sandwich can be simple: grilled cheese, tuna melt, deli, or lettuce wrap.",
    },
    cadence: {
      suggestedDays: ["Tue", "Thu", "Sun"],
      window: "60-120min",
      anchors: ["prep_day_optional", "family_dinner"],
    },
    blocks: [
      {
        id: "block_soup",
        name: "Soup Cook",
        role: "main",
        notes: "Hearty soup as dinner.",
      },
      {
        id: "block_lunch_prep",
        name: "Lunch Prep",
        role: "leftovers",
        notes: "Reserve soup + sandwich parts.",
      },
    ],
    tasks: [
      cTask({
        methodKey: COOK_METHOD_KEYS.PLAN_MENU,
        title: "Choose soup type and sandwich type",
        minutes: 8,
        phase: "plan",
        notes:
          "Examples: chicken noodle, broccoli cheddar, black bean, lamb stew. Sandwich: grilled cheese, tuna melt, wraps.",
      }),
      cTask({
        methodKey: COOK_METHOD_KEYS.MISE_EN_PLACE,
        title: "Gather soup ingredients + prep station",
        minutes: 10,
        phase: "prep",
        tools: COOK_TOOL_HINTS.SOUP,
      }),
      cTask({
        methodKey: COOK_METHOD_KEYS.CHOP,
        title: "Chop aromatics/vegetables",
        minutes: 12,
        phase: "prep",
      }),
      cTask({
        methodKey: COOK_METHOD_KEYS.SAUTE,
        title: "Sauté aromatics (base flavor)",
        minutes: 8,
        phase: "cook",
        timers: [{ label: "Sauté", minutes: 8 }],
      }),
      cTask({
        methodKey: COOK_METHOD_KEYS.SOUP,
        title: "Simmer soup until done",
        minutes: 45,
        phase: "cook",
        timers: [{ label: "Simmer", minutes: 35 }],
        notes:
          "Use this simmer window to set table, prep sandwich components, and tidy kitchen.",
      }),
      cTask({
        methodKey: COOK_METHOD_KEYS.HOLD_WARM,
        title: "Hold soup warm (if needed)",
        minutes: 10,
        phase: "serve",
        notes: "Low heat with lid; prevent scorching.",
      }),
      cTask({
        methodKey: COOK_METHOD_KEYS.PLATE,
        title: "Serve soup dinner",
        minutes: 10,
        phase: "serve",
      }),
      cTask({
        methodKey: COOK_METHOD_KEYS.PACKAGE_LEFTOVERS,
        title: "Reserve soup portions for lunch",
        minutes: 10,
        phase: "preserve",
        tools: COOK_TOOL_HINTS.PACKING,
        supplies: ["containers", "labels"],
        notes:
          "Reserve 2–4 portions. Optionally freeze 1 portion for emergency lunch.",
      }),
      cTask({
        methodKey: COOK_METHOD_KEYS.PLAN_LEFTOVERS,
        title: "Set aside sandwich components (bread/cheese/protein)",
        minutes: 6,
        phase: "preserve",
        notes:
          "If bread is homemade, slice and bag. If wraps, portion fillings.",
      }),
      cTask({
        methodKey: COOK_METHOD_KEYS.CLEANUP,
        title: "Cleanup (pot + prep area)",
        minutes: 15,
        phase: "cleanup",
      }),
    ],
    supplyHints: {
      ingredients: [
        "soup_base (broth/beans)",
        "aromatics",
        "protein_optional",
        "sandwich_components",
      ],
      tools: COOK_TOOL_HINTS.SOUP,
      pantry: [...COOK_SUPPLY_HINTS.staples, ...COOK_SUPPLY_HINTS.soups],
    },
  },

  /* -------------------------------------------------------------------------
   * 3) Batch Cook Core: Protein + Starch + Veg (Multi-Meal)
   * ---------------------------------------------------------------------- */
  {
    id: "batch_cook_core_protein_starch_veg",
    name: "Batch Cook Core (Protein + Starch + Veg)",
    description:
      "A batch session template to create mix-and-match components: cooked proteins, a starch/grain, and roasted/steamed vegetables for multiple meals.",
    tags: {
      mealType: ["batch_session"],
      rhythmRole: ["prep_day_anchor", "week_planning"],
      difficulty: "intermediate",
      cuisineNeutral: true,
      equipment: ["oven", "stovetop", "optional_pressure_cooker"],
      dietModes: ["balanced", "keto_variant", "high_protein"],
    },
    assumptions: {
      portions: { mealsBuilt: 8 },
      leftoversPolicy: "portion_and_label",
      notes:
        "Build 3–4 meals by recombining components. Add sauces from cuisine profiles later.",
    },
    cadence: {
      suggestedDays: ["Sun"],
      window: "2-3hr",
      anchors: ["prep_day"],
    },
    blocks: [
      {
        id: "block_protein",
        name: "Protein Cook",
        role: "core",
        notes: "Roast, grill, or pressure cook.",
      },
      {
        id: "block_starch",
        name: "Starch/Grain",
        role: "core",
        notes: "Rice/grain or keto alternative.",
      },
      {
        id: "block_veg",
        name: "Vegetables",
        role: "core",
        notes: "Roast + steam.",
      },
      {
        id: "block_pack",
        name: "Portion + Label",
        role: "preserve",
        notes: "Make grab-and-go.",
      },
    ],
    tasks: [
      cTask({
        methodKey: COOK_METHOD_KEYS.PLAN_MENU,
        title: "Select 2 proteins, 1 starch, 2 vegetables, 2 sauces",
        minutes: 12,
        phase: "plan",
        notes:
          "Example proteins: chicken thighs + beef roast / lamb shoulder / goat stew. Starch: rice. Veg: broccoli + carrots.",
      }),
      cTask({
        methodKey: COOK_METHOD_KEYS.THAW,
        title: "Thaw proteins if frozen",
        minutes: 3,
        phase: "prep",
        notes: "If not thawed, adjust to pressure cook or extend roast time.",
      }),
      cTask({
        methodKey: COOK_METHOD_KEYS.PREHEAT,
        title: "Preheat oven and set stations",
        minutes: 5,
        phase: "prep",
        tools: COOK_TOOL_HINTS.OVEN,
        timers: [{ label: "Preheat", minutes: 12 }],
      }),
      cTask({
        methodKey: COOK_METHOD_KEYS.MISE_EN_PLACE,
        title: "Set up batch workflow: trays, pots, containers",
        minutes: 10,
        phase: "prep",
        tools: [...COOK_TOOL_HINTS.BASIC, ...COOK_TOOL_HINTS.PACKING],
      }),
      cTask({
        methodKey: COOK_METHOD_KEYS.SEASON,
        title: "Season proteins",
        minutes: 10,
        phase: "prep",
        supplies: COOK_SUPPLY_HINTS.staples,
      }),
      cTask({
        methodKey: COOK_METHOD_KEYS.ROAST,
        title: "Cook proteins (roast or bake)",
        minutes: 60,
        phase: "cook",
        tools: COOK_TOOL_HINTS.OVEN,
        timers: [{ label: "Protein cook", minutes: 45 }],
        notes: "Use thermometer. Stagger trays if needed to manage oven space.",
      }),
      cTask({
        methodKey: COOK_METHOD_KEYS.RICE,
        title: "Cook rice / grain",
        minutes: 35,
        phase: "cook",
        tools: ["pot", "lid"],
        timers: [{ label: "Rice simmer", minutes: 18 }],
        notes: "Or use rice cooker if available.",
      }),
      cTask({
        methodKey: COOK_METHOD_KEYS.VEG_SIDE,
        title: "Roast or steam vegetables",
        minutes: 35,
        phase: "cook",
        tools: ["sheet_pan", "steamer_basket (optional)"],
        timers: [{ label: "Veg cook", minutes: 20 }],
      }),
      cTask({
        methodKey: COOK_METHOD_KEYS.REST_MEAT,
        title: "Rest proteins and slice/shred",
        minutes: 15,
        phase: "cook",
        timers: [{ label: "Rest", minutes: 10 }],
      }),
      cTask({
        methodKey: COOK_METHOD_KEYS.PACKAGE_LEFTOVERS,
        title: "Portion meals and label",
        minutes: 25,
        phase: "preserve",
        tools: COOK_TOOL_HINTS.PACKING,
        supplies: ["containers", "labels", "marker"],
        notes:
          "Create: 4 complete meals + 4 component packs. Mark dates + contents.",
      }),
      cTask({
        methodKey: COOK_METHOD_KEYS.FREEZE,
        title: "Freeze 2–4 portions for later (optional)",
        minutes: 8,
        phase: "preserve",
        tools: COOK_TOOL_HINTS.PACKING,
        supplies: ["freezer_bags", "labels"],
      }),
      cTask({
        methodKey: COOK_METHOD_KEYS.CLEANUP,
        title: "Cleanup (batch stations)",
        minutes: 20,
        phase: "cleanup",
        notes: "Soak pans; wipe counters; reset kitchen for the week.",
      }),
    ],
    supplyHints: {
      ingredients: [
        "2_proteins",
        "1_starch_or_alt",
        "2_vegetables",
        "2_sauces",
      ],
      tools: [...COOK_TOOL_HINTS.OVEN, ...COOK_TOOL_HINTS.PACKING],
      pantry: [...COOK_SUPPLY_HINTS.staples, ...COOK_SUPPLY_HINTS.grains],
    },
  },

  /* -------------------------------------------------------------------------
   * 4) Quick Breakfast Prep (Eggs + Waffles + Meat)
   * ---------------------------------------------------------------------- */
  {
    id: "breakfast_prep_eggs_waffles_meat",
    name: "Breakfast Prep (Eggs + Waffles + Meat)",
    description:
      "A breakfast prep pattern aligned to your preferences: eggs + waffles + lamb/beef sausage/bacon (or goat). Includes freezer-friendly waffles.",
    tags: {
      mealType: ["breakfast", "prep"],
      rhythmRole: ["morning_anchor", "batch_small"],
      difficulty: "beginner",
      cuisineNeutral: true,
      equipment: ["waffle_iron", "stovetop"],
      dietModes: ["balanced", "high_protein"],
    },
    assumptions: {
      portions: { breakfasts: 6 },
      leftoversPolicy: "freeze_waffles",
      notes:
        "Make waffles in a batch and freeze. Reheat in toaster/oven for fast mornings.",
    },
    cadence: {
      suggestedDays: ["Sat", "Sun"],
      window: "60-90min",
      anchors: ["weekend_prep"],
    },
    blocks: [
      {
        id: "block_waffles",
        name: "Waffles",
        role: "core",
        notes: "Batch and freeze.",
      },
      {
        id: "block_meat",
        name: "Breakfast Meat",
        role: "core",
        notes: "Sausage/bacon (lamb/beef/goat).",
      },
      {
        id: "block_eggs",
        name: "Eggs",
        role: "serve",
        notes: "Cook fresh or prep egg bites.",
      },
    ],
    tasks: [
      cTask({
        methodKey: COOK_METHOD_KEYS.MISE_EN_PLACE,
        title: "Set stations: waffle batter, meat pan, packing",
        minutes: 10,
        phase: "prep",
        tools: [
          "waffle_iron",
          "mixing_bowls",
          "skillet",
          "containers",
          "labels",
        ],
      }),
      cTask({
        methodKey: COOK_METHOD_KEYS.BAKE,
        title: "Cook waffles (batch)",
        minutes: 35,
        phase: "cook",
        timers: [{ label: "Waffle batch", minutes: 30 }],
        notes: "Cool waffles before freezing to avoid sogginess.",
      }),
      cTask({
        methodKey: COOK_METHOD_KEYS.SAUTE,
        title: "Cook breakfast sausage/bacon",
        minutes: 20,
        phase: "cook",
        timers: [{ label: "Meat cook", minutes: 15 }],
        notes: "Option: bake bacon on sheet pan for hands-off cooking.",
      }),
      cTask({
        methodKey: COOK_METHOD_KEYS.PACKAGE_LEFTOVERS,
        title: "Freeze waffles + portion meats",
        minutes: 15,
        phase: "preserve",
        tools: COOK_TOOL_HINTS.PACKING,
        supplies: ["freezer_bags", "labels"],
      }),
      cTask({
        methodKey: COOK_METHOD_KEYS.CLEANUP,
        title: "Cleanup breakfast stations",
        minutes: 12,
        phase: "cleanup",
      }),
    ],
    supplyHints: {
      ingredients: [
        "waffle_batter_staples",
        "eggs",
        "lamb/beef/goat breakfast meats",
      ],
      tools: ["waffle_iron", "skillet", "sheet_pan (optional)"],
      pantry: [
        "flour",
        "baking_powder",
        "salt",
        "oil/butter",
        "freezer_bags",
        "labels",
      ],
    },
  },
];

const FrozenTemplates = deepFreeze(TEMPLATES);

/* -----------------------------------------------------------------------------
 * Public API
 * -------------------------------------------------------------------------- */

export const CookPlanTemplates = FrozenTemplates;

/**
 * List templates with optional filtering.
 * filters: { mealType, rhythmRole, difficulty, dietMode, equipment }
 */
export function listCookPlanTemplates(filters = {}) {
  const f = safeObj(filters);
  const mealType = f.mealType ? keyOf(f.mealType) : null;
  const rhythmRole = f.rhythmRole ? keyOf(f.rhythmRole) : null;
  const difficulty = f.difficulty ? keyOf(f.difficulty) : null;
  const dietMode = f.dietMode ? keyOf(f.dietMode) : null;
  const equipment = f.equipment ? keyOf(f.equipment) : null;

  return FrozenTemplates.filter((t) => {
    const tags = safeObj(t.tags);
    if (mealType && !safeArr(tags.mealType).map(keyOf).includes(mealType))
      return false;
    if (rhythmRole && !safeArr(tags.rhythmRole).map(keyOf).includes(rhythmRole))
      return false;
    if (difficulty && keyOf(tags.difficulty) !== difficulty) return false;
    if (dietMode && !safeArr(tags.dietModes).map(keyOf).includes(dietMode))
      return false;
    if (equipment && !safeArr(tags.equipment).map(keyOf).includes(equipment))
      return false;
    return true;
  });
}

/**
 * Get a template by id.
 */
export function getCookPlanTemplate(id) {
  const key = keyOf(id);
  return FrozenTemplates.find((t) => keyOf(t.id) === key) || null;
}

/**
 * For UIs: small card summaries.
 */
export function getCookPlanCards(filters = {}) {
  return listCookPlanTemplates(filters).map((t) => ({
    id: t.id,
    name: t.name,
    description: t.description,
    tags: t.tags,
    assumptions: t.assumptions,
    blockCount: safeArr(t.blocks).length,
    taskCount: safeArr(t.tasks).length,
    source: SOURCE,
  }));
}

/**
 * Return blueprint-ready tasks from a template.
 * options: { phase }
 */
export function getCookPlanTasks(id, options = {}) {
  const tpl = getCookPlanTemplate(id);
  if (!tpl) return [];
  const opts = safeObj(options);
  const phase = opts.phase ? String(opts.phase) : null;

  let tasks = safeArr(tpl.tasks);
  if (phase) tasks = tasks.filter((x) => String(x.phase) === phase);
  return tasks;
}

/**
 * Return blocks from a template.
 */
export function getCookPlanBlocks(id) {
  const tpl = getCookPlanTemplate(id);
  return tpl ? safeArr(tpl.blocks) : [];
}

export default CookPlanTemplates;
