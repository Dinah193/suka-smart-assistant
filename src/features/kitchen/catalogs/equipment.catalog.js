/* eslint-disable no-console */
// C:\Users\larho\suka-smart-assistant\src\features\kitchen\catalogs\equipment.catalog.js
//
// SSA • Equipment Catalog (canonical tool/appliance IDs + labels)
// -----------------------------------------------------------------------------
// Purpose:
//   Canonical registry of kitchen equipment IDs used across SSA:
//     - recipes adaptation (CapabilityMatcher / ToolSubstitutionRules)
//     - CookSetupModal equipment checklist
//     - cooking sessions (SessionRunner requirements)
//     - meal planning / shopping (what to buy / what you already have)
//
// Design goals:
//   - Stable IDs (snake_case) + clear labels
//   - Categorized + searchable
//   - Includes aliases for intake parsing and UI typeahead
//   - Browser-safe (no Node deps), deterministic
//
// Data contract:
//   EQUIPMENT_CATALOG: Array<{
//     id: string,
//     label: string,
//     category: string,
//     type: "tool"|"appliance"|"cookware"|"bakeware"|"utensil"|"safety"|"storage"|"prep"|"heat_source"|"measurement"|"cleaning"|"other",
//     aliases?: string[],
//     tags?: string[],
//     icon?: string,           // optional: lucide icon name or emoji string
//     notes?: string,
//     priority?: number,       // for UI sort (higher shows earlier)
//   }>
//
// Helper exports:
//   - EQUIPMENT_BY_ID: Record<string, item>
//   - listEquipment({ category, type, tag, q, ids })
//   - getEquipment(id)
//   - searchEquipment(q)
//   - normalizeEquipmentId(str)
//
// No placeholders. Production-ready.

const VERSION = "1.0.0";

/* ------------------------------ helpers ------------------------------ */

function isPlainObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function safeString(s, max = 160, fallback = "") {
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
        .map((x) => safeString(String(x), 80, ""))
        .filter(Boolean)
    )
  );
}

function stableId(id) {
  const t = safeLower(id)
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_:-]/g, "");
  return t;
}

function normalizeEquipmentId(input) {
  if (!input) return "";
  const t = safeLower(String(input));
  // Try to map common punctuation variants.
  return stableId(
    t
      .replace(/&/g, "and")
      .replace(/\+/g, "plus")
      .replace(/\//g, "_")
      .replace(/-/g, "_")
      .replace(/\./g, "")
      .replace(/'/g, "")
  );
}

function matchesQ(item, q) {
  const qq = safeLower(q);
  if (!qq) return true;
  const hay = [
    item.id,
    item.label,
    item.category,
    item.type,
    ...(item.aliases || []),
    ...(item.tags || []),
    item.notes || "",
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return hay.includes(qq);
}

/* ------------------------------ catalog ------------------------------ */
/**
 * NOTE: Keep IDs stable. Adding is fine; renaming breaks persisted records.
 * If you must rename, add an alias and keep the old ID as deprecated.
 */
const EQUIPMENT_CATALOG = Object.freeze([
  /* ---------------- Heat sources / core appliances ---------------- */
  {
    id: "stove_gas",
    label: "Gas stove / cooktop",
    category: "Heat source",
    type: "heat_source",
    aliases: ["gas cooktop", "gas range", "burner", "hob", "gas stove"],
    tags: ["stovetop", "gas"],
    icon: "🔥",
    priority: 100,
  },
  {
    id: "stove_electric",
    label: "Electric stove / cooktop",
    category: "Heat source",
    type: "heat_source",
    aliases: [
      "electric cooktop",
      "electric range",
      "coil stove",
      "burner",
      "hob",
      "electric stove",
    ],
    tags: ["stovetop", "electric"],
    icon: "⚡",
    priority: 98,
  },
  {
    id: "stove_induction",
    label: "Induction cooktop",
    category: "Heat source",
    type: "heat_source",
    aliases: ["induction stove", "induction burner", "induction hob"],
    tags: ["stovetop", "induction"],
    icon: "⚡",
    priority: 96,
  },
  {
    id: "oven_conventional",
    label: "Oven",
    category: "Heat source",
    type: "appliance",
    aliases: ["bake", "roast", "oven conventional"],
    tags: ["baking", "roasting"],
    icon: "🔥",
    priority: 95,
  },
  {
    id: "oven_convection",
    label: "Convection oven",
    category: "Heat source",
    type: "appliance",
    aliases: ["fan oven", "convection bake", "convection roast"],
    tags: ["baking", "roasting", "convection"],
    icon: "🌬️",
    priority: 94,
  },
  {
    id: "toaster_oven",
    label: "Toaster oven",
    category: "Small appliances",
    type: "appliance",
    aliases: ["countertop oven", "mini oven"],
    tags: ["baking", "toasting"],
    icon: "🍞",
    priority: 70,
  },
  {
    id: "air_fryer",
    label: "Air fryer",
    category: "Small appliances",
    type: "appliance",
    aliases: ["airfryer", "air fryer oven"],
    tags: ["convection", "roasting", "frying"],
    icon: "🌬️",
    priority: 72,
  },
  {
    id: "microwave",
    label: "Microwave",
    category: "Small appliances",
    type: "appliance",
    aliases: ["microwave oven", "mw"],
    tags: ["reheat", "defrost"],
    icon: "📡",
    priority: 60,
  },
  {
    id: "pressure_cooker_electric",
    label: "Electric pressure cooker (Instant Pot)",
    category: "Small appliances",
    type: "appliance",
    aliases: ["instant pot", "ip", "electric pressure cooker", "multi cooker"],
    tags: ["pressure", "slow_cook", "steam"],
    icon: "⏲️",
    priority: 78,
  },
  {
    id: "pressure_cooker_stovetop",
    label: "Stovetop pressure cooker",
    category: "Cookware",
    type: "cookware",
    aliases: ["pressure cooker", "stovetop pressure"],
    tags: ["pressure"],
    icon: "⏲️",
    priority: 76,
  },
  {
    id: "slow_cooker",
    label: "Slow cooker (Crock-Pot)",
    category: "Small appliances",
    type: "appliance",
    aliases: ["crock pot", "crockpot", "slow cooker"],
    tags: ["slow_cook", "braise"],
    icon: "🥘",
    priority: 65,
  },
  {
    id: "rice_cooker",
    label: "Rice cooker",
    category: "Small appliances",
    type: "appliance",
    aliases: ["rice pot"],
    tags: ["rice", "steam"],
    icon: "🍚",
    priority: 64,
  },
  {
    id: "grill_outdoor",
    label: "Outdoor grill",
    category: "Outdoor cooking",
    type: "appliance",
    aliases: [
      "bbq",
      "barbecue",
      "barbeque",
      "charcoal grill",
      "gas grill",
      "grill",
    ],
    tags: ["grill", "smoke", "outdoor"],
    icon: "🔥",
    priority: 88,
  },
  {
    id: "griddle",
    label: "Griddle (stovetop or electric)",
    category: "Cookware",
    type: "cookware",
    aliases: ["flat top", "flat-top", "plancha"],
    tags: ["sear", "breakfast"],
    icon: "🥞",
    priority: 55,
  },
  {
    id: "smoker",
    label: "Smoker",
    category: "Outdoor cooking",
    type: "appliance",
    aliases: ["smokehouse", "pellet smoker", "offset smoker"],
    tags: ["smoke", "low_and_slow"],
    icon: "🌫️",
    priority: 50,
  },
  {
    id: "deep_fryer",
    label: "Deep fryer",
    category: "Small appliances",
    type: "appliance",
    aliases: ["fryer", "electric fryer"],
    tags: ["fry"],
    icon: "🍟",
    priority: 30,
  },
  {
    id: "waffle_iron",
    label: "Waffle iron",
    category: "Small appliances",
    type: "appliance",
    aliases: ["waffle maker"],
    tags: ["breakfast", "baking"],
    icon: "🧇",
    priority: 35,
  },
  {
    id: "blender",
    label: "Blender",
    category: "Small appliances",
    type: "appliance",
    aliases: ["countertop blender", "smoothie blender"],
    tags: ["puree", "smoothie"],
    icon: "🥤",
    priority: 62,
  },
  {
    id: "immersion_blender",
    label: "Immersion blender",
    category: "Small appliances",
    type: "appliance",
    aliases: ["stick blender", "hand blender"],
    tags: ["puree", "soup"],
    icon: "🥣",
    priority: 58,
  },
  {
    id: "food_processor",
    label: "Food processor",
    category: "Small appliances",
    type: "appliance",
    aliases: ["processor", "fp"],
    tags: ["chop", "slice", "shred"],
    icon: "⚙️",
    priority: 60,
  },
  {
    id: "stand_mixer",
    label: "Stand mixer",
    category: "Small appliances",
    type: "appliance",
    aliases: ["kitchenaid", "mixer stand"],
    tags: ["mix", "knead", "baking"],
    icon: "⚙️",
    priority: 60,
  },
  {
    id: "hand_mixer",
    label: "Hand mixer",
    category: "Small appliances",
    type: "appliance",
    aliases: ["electric hand mixer"],
    tags: ["mix", "baking"],
    icon: "⚙️",
    priority: 50,
  },
  {
    id: "bread_machine",
    label: "Bread machine",
    category: "Small appliances",
    type: "appliance",
    aliases: ["bread maker"],
    tags: ["baking", "knead"],
    icon: "🍞",
    priority: 22,
  },
  {
    id: "coffee_grinder",
    label: "Electric grinder (spice/coffee)",
    category: "Small appliances",
    type: "appliance",
    aliases: ["spice grinder", "coffee grinder", "electric mill"],
    tags: ["grind", "spice"],
    icon: "🫘",
    priority: 40,
  },

  /* ---------------- Cookware (pots/pans) ---------------- */
  {
    id: "skillet_cast_iron",
    label: "Cast iron skillet",
    category: "Cookware",
    type: "cookware",
    aliases: ["cast iron pan", "ci skillet", "frying pan cast iron"],
    tags: ["sear", "stovetop", "oven_safe"],
    icon: "🍳",
    priority: 85,
  },
  {
    id: "skillet_nonstick",
    label: "Nonstick skillet",
    category: "Cookware",
    type: "cookware",
    aliases: ["non stick pan", "teflon pan", "frying pan nonstick"],
    tags: ["eggs", "stovetop"],
    icon: "🍳",
    priority: 80,
  },
  {
    id: "skillet_stainless",
    label: "Stainless steel skillet",
    category: "Cookware",
    type: "cookware",
    aliases: ["stainless pan", "frying pan stainless"],
    tags: ["sear", "deglaze"],
    icon: "🍳",
    priority: 78,
  },
  {
    id: "saucepan",
    label: "Saucepan",
    category: "Cookware",
    type: "cookware",
    aliases: ["small pot", "pot small"],
    tags: ["simmer", "sauce"],
    icon: "🥘",
    priority: 75,
  },
  {
    id: "stockpot",
    label: "Stockpot",
    category: "Cookware",
    type: "cookware",
    aliases: ["large pot", "soup pot"],
    tags: ["boil", "stock", "soup"],
    icon: "🍲",
    priority: 74,
  },
  {
    id: "dutch_oven",
    label: "Dutch oven",
    category: "Cookware",
    type: "cookware",
    aliases: ["enameled dutch oven", "cocotte"],
    tags: ["braise", "roast", "soup", "oven_safe"],
    icon: "🥘",
    priority: 83,
  },
  {
    id: "wok",
    label: "Wok",
    category: "Cookware",
    type: "cookware",
    aliases: ["stir fry pan", "wok pan"],
    tags: ["stir_fry", "high_heat"],
    icon: "🥡",
    priority: 45,
  },
  {
    id: "sheet_pan",
    label: "Sheet pan",
    category: "Bakeware",
    type: "bakeware",
    aliases: [
      "baking sheet",
      "cookie sheet",
      "half sheet",
      "rimmed baking sheet",
    ],
    tags: ["roast", "bake"],
    icon: "🟫",
    priority: 78,
  },
  {
    id: "roasting_pan",
    label: "Roasting pan",
    category: "Bakeware",
    type: "bakeware",
    aliases: ["roaster pan"],
    tags: ["roast"],
    icon: "🟫",
    priority: 42,
  },
  {
    id: "casserole_dish",
    label: "Casserole dish",
    category: "Bakeware",
    type: "bakeware",
    aliases: ["baking dish", "pyrex dish"],
    tags: ["bake", "gratins"],
    icon: "🟫",
    priority: 48,
  },
  {
    id: "loaf_pan",
    label: "Loaf pan",
    category: "Bakeware",
    type: "bakeware",
    aliases: ["bread pan"],
    tags: ["bake", "bread"],
    icon: "🍞",
    priority: 35,
  },
  {
    id: "muffin_tin",
    label: "Muffin tin",
    category: "Bakeware",
    type: "bakeware",
    aliases: ["cupcake pan"],
    tags: ["bake"],
    icon: "🧁",
    priority: 22,
  },
  {
    id: "cake_pan",
    label: "Cake pan",
    category: "Bakeware",
    type: "bakeware",
    aliases: ["round cake pan", "sheet cake pan"],
    tags: ["bake"],
    icon: "🍰",
    priority: 20,
  },
  {
    id: "pie_dish",
    label: "Pie dish",
    category: "Bakeware",
    type: "bakeware",
    aliases: ["pie plate"],
    tags: ["bake"],
    icon: "🥧",
    priority: 18,
  },

  /* ---------------- Prep tools ---------------- */
  {
    id: "cutting_board",
    label: "Cutting board",
    category: "Prep",
    type: "prep",
    aliases: ["board", "chopping board"],
    tags: ["prep"],
    icon: "🪵",
    priority: 90,
  },
  {
    id: "chef_knife",
    label: "Chef’s knife",
    category: "Prep",
    type: "tool",
    aliases: ["chef knife", "knife"],
    tags: ["prep", "cut"],
    icon: "🔪",
    priority: 92,
  },
  {
    id: "paring_knife",
    label: "Paring knife",
    category: "Prep",
    type: "tool",
    aliases: ["small knife"],
    tags: ["prep", "cut"],
    icon: "🔪",
    priority: 60,
  },
  {
    id: "serrated_knife",
    label: "Serrated knife",
    category: "Prep",
    type: "tool",
    aliases: ["bread knife"],
    tags: ["prep", "cut"],
    icon: "🔪",
    priority: 40,
  },
  {
    id: "kitchen_shears",
    label: "Kitchen shears",
    category: "Prep",
    type: "tool",
    aliases: ["shears", "scissors"],
    tags: ["prep"],
    icon: "✂️",
    priority: 35,
  },
  {
    id: "peeler",
    label: "Vegetable peeler",
    category: "Prep",
    type: "tool",
    aliases: ["peeler", "y peeler"],
    tags: ["prep"],
    icon: "🥕",
    priority: 35,
  },
  {
    id: "box_grater",
    label: "Box grater",
    category: "Prep",
    type: "tool",
    aliases: ["grater", "cheese grater"],
    tags: ["grate", "shred"],
    icon: "🧀",
    priority: 30,
  },
  {
    id: "microplane",
    label: "Microplane / zester",
    category: "Prep",
    type: "tool",
    aliases: ["zester", "microplane", "fine grater"],
    tags: ["zest", "grate"],
    icon: "🍋",
    priority: 25,
  },
  {
    id: "garlic_press",
    label: "Garlic press",
    category: "Prep",
    type: "tool",
    aliases: ["press garlic"],
    tags: ["prep"],
    icon: "🧄",
    priority: 15,
  },
  {
    id: "mortar_pestle",
    label: "Mortar & pestle",
    category: "Prep",
    type: "tool",
    aliases: ["mortar and pestle", "grind spices"],
    tags: ["grind", "spice"],
    icon: "🪨",
    priority: 12,
  },
  {
    id: "mandoline",
    label: "Mandoline slicer",
    category: "Prep",
    type: "tool",
    aliases: ["mandolin", "slicer"],
    tags: ["slice"],
    icon: "🥒",
    priority: 12,
    notes: "Use cut-resistant glove.",
  },
  {
    id: "can_opener",
    label: "Can opener",
    category: "Prep",
    type: "tool",
    aliases: ["tin opener"],
    tags: ["prep"],
    icon: "🥫",
    priority: 30,
  },

  /* ---------------- Utensils ---------------- */
  {
    id: "spatula",
    label: "Spatula / turner",
    category: "Utensils",
    type: "utensil",
    aliases: ["turner", "flipper"],
    tags: ["flip"],
    icon: "🍳",
    priority: 60,
  },
  {
    id: "silicone_spatula",
    label: "Silicone spatula",
    category: "Utensils",
    type: "utensil",
    aliases: ["rubber spatula"],
    tags: ["scrape"],
    icon: "🥄",
    priority: 40,
  },
  {
    id: "tongs",
    label: "Tongs",
    category: "Utensils",
    type: "utensil",
    aliases: ["kitchen tongs"],
    tags: ["turn", "grill"],
    icon: "🧲",
    priority: 55,
  },
  {
    id: "whisk",
    label: "Whisk",
    category: "Utensils",
    type: "utensil",
    aliases: ["wire whisk"],
    tags: ["mix"],
    icon: "🥄",
    priority: 45,
  },
  {
    id: "ladle",
    label: "Ladle",
    category: "Utensils",
    type: "utensil",
    aliases: ["soup ladle"],
    tags: ["serve"],
    icon: "🥄",
    priority: 25,
  },
  {
    id: "wooden_spoon",
    label: "Wooden spoon",
    category: "Utensils",
    type: "utensil",
    aliases: ["spoon wooden"],
    tags: ["stir"],
    icon: "🥄",
    priority: 50,
  },
  {
    id: "slotted_spoon",
    label: "Slotted spoon",
    category: "Utensils",
    type: "utensil",
    aliases: ["spoon slotted"],
    tags: ["drain"],
    icon: "🥄",
    priority: 20,
  },

  /* ---------------- Measurement ---------------- */
  {
    id: "instant_read_thermometer",
    label: "Instant-read thermometer",
    category: "Measurement",
    type: "measurement",
    aliases: ["meat thermometer", "thermometer", "probe thermometer"],
    tags: ["temperature", "doneness"],
    icon: "🌡️",
    priority: 85,
  },
  {
    id: "oven_thermometer",
    label: "Oven thermometer",
    category: "Measurement",
    type: "measurement",
    aliases: ["oven temp gauge"],
    tags: ["temperature"],
    icon: "🌡️",
    priority: 15,
  },
  {
    id: "kitchen_scale",
    label: "Kitchen scale",
    category: "Measurement",
    type: "measurement",
    aliases: ["digital scale", "food scale"],
    tags: ["weight"],
    icon: "⚖️",
    priority: 70,
  },
  {
    id: "measuring_cups",
    label: "Measuring cups",
    category: "Measurement",
    type: "measurement",
    aliases: ["cup measures", "dry measuring cups"],
    tags: ["volume"],
    icon: "🥛",
    priority: 65,
  },
  {
    id: "measuring_spoons",
    label: "Measuring spoons",
    category: "Measurement",
    type: "measurement",
    aliases: ["spoon measures"],
    tags: ["volume"],
    icon: "🥄",
    priority: 65,
  },
  {
    id: "liquid_measuring_cup",
    label: "Liquid measuring cup",
    category: "Measurement",
    type: "measurement",
    aliases: ["pyrex measuring cup"],
    tags: ["volume"],
    icon: "🥛",
    priority: 35,
  },
  {
    id: "timer",
    label: "Kitchen timer",
    category: "Measurement",
    type: "measurement",
    aliases: ["timer", "stopwatch"],
    tags: ["time"],
    icon: "⏲️",
    priority: 30,
  },

  /* ---------------- Baking / pastry tools ---------------- */
  {
    id: "rolling_pin",
    label: "Rolling pin",
    category: "Baking tools",
    type: "tool",
    aliases: ["roll pin"],
    tags: ["baking", "dough"],
    icon: "🥖",
    priority: 22,
  },
  {
    id: "mixing_bowls",
    label: "Mixing bowls",
    category: "Baking tools",
    type: "prep",
    aliases: ["bowls", "prep bowls"],
    tags: ["mix", "prep"],
    icon: "🥣",
    priority: 70,
  },
  {
    id: "baking_rack",
    label: "Cooling rack",
    category: "Baking tools",
    type: "tool",
    aliases: ["wire rack", "cooling rack"],
    tags: ["baking"],
    icon: "🧁",
    priority: 20,
  },
  {
    id: "stand_mixer_dough_hook",
    label: "Stand mixer dough hook",
    category: "Baking tools",
    type: "tool",
    aliases: ["dough hook"],
    tags: ["knead"],
    icon: "⚙️",
    priority: 10,
  },

  /* ---------------- Storage / safety ---------------- */
  {
    id: "aluminum_foil",
    label: "Aluminum foil",
    category: "Consumables",
    type: "storage",
    aliases: ["foil"],
    tags: ["cover", "wrap"],
    icon: "🧻",
    priority: 35,
  },
  {
    id: "parchment_paper",
    label: "Parchment paper",
    category: "Consumables",
    type: "storage",
    aliases: ["parchment"],
    tags: ["bake", "line_pan"],
    icon: "📄",
    priority: 30,
  },
  {
    id: "plastic_wrap",
    label: "Plastic wrap",
    category: "Consumables",
    type: "storage",
    aliases: ["cling film", "saran wrap"],
    tags: ["wrap", "cover"],
    icon: "🧻",
    priority: 20,
  },
  {
    id: "food_storage_containers",
    label: "Food storage containers",
    category: "Storage",
    type: "storage",
    aliases: ["containers", "tupperware"],
    tags: ["storage"],
    icon: "📦",
    priority: 50,
  },
  {
    id: "oven_mitts",
    label: "Oven mitts",
    category: "Safety",
    type: "safety",
    aliases: ["mitts", "pot holders"],
    tags: ["heat_protection"],
    icon: "🧤",
    priority: 60,
  },
  {
    id: "cut_resistant_glove",
    label: "Cut-resistant glove",
    category: "Safety",
    type: "safety",
    aliases: ["cut glove", "mandoline glove"],
    tags: ["knife_safety"],
    icon: "🧤",
    priority: 10,
  },

  /* ---------------- Cleaning ---------------- */
  {
    id: "dish_soap",
    label: "Dish soap",
    category: "Cleaning",
    type: "cleaning",
    aliases: ["dish detergent"],
    tags: ["clean"],
    icon: "🧼",
    priority: 18,
  },
  {
    id: "scrub_brush",
    label: "Scrub brush",
    category: "Cleaning",
    type: "cleaning",
    aliases: ["brush", "dish brush"],
    tags: ["clean"],
    icon: "🧽",
    priority: 10,
  },
]);

/* ------------------------------ build index ------------------------------ */

function buildIndex(list) {
  const byId = {};
  const aliasToId = {};
  list.forEach((raw) => {
    const item = isPlainObject(raw) ? raw : {};
    const id = normalizeEquipmentId(item.id);
    if (!id) return;

    const entry = {
      id,
      label: safeString(item.label || id.replace(/_/g, " "), 200, id),
      category: safeString(item.category || "Other", 80, "Other"),
      type: safeString(item.type || "other", 40, "other"),
      aliases: uniq(item.aliases || []),
      tags: uniq(item.tags || []),
      icon: safeString(item.icon || "", 12, ""),
      notes: safeString(item.notes || "", 800, ""),
      priority: Number.isFinite(Number(item.priority))
        ? Number(item.priority)
        : 0,
      deprecated: !!item.deprecated,
      replaces: safeString(item.replaces || "", 120, ""),
    };

    byId[id] = Object.freeze(entry);

    // map aliases
    entry.aliases.forEach((a) => {
      const key = normalizeEquipmentId(a);
      if (!key) return;
      aliasToId[key] = id;
    });

    // also map label itself
    const labelKey = normalizeEquipmentId(entry.label);
    if (labelKey && !aliasToId[labelKey]) aliasToId[labelKey] = id;

    // id itself
    aliasToId[id] = id;
  });

  return {
    byId: Object.freeze(byId),
    aliasToId: Object.freeze(aliasToId),
  };
}

const { byId: EQUIPMENT_BY_ID, aliasToId: EQUIPMENT_ALIAS_TO_ID } =
  buildIndex(EQUIPMENT_CATALOG);

/* ------------------------------ API ------------------------------ */

function getEquipment(id) {
  const key = normalizeEquipmentId(id);
  if (!key) return null;
  const mapped = EQUIPMENT_ALIAS_TO_ID[key] || key;
  return EQUIPMENT_BY_ID[mapped] || null;
}

function listEquipment({ category, type, tag, q, ids } = {}) {
  const cat = safeLower(category || "");
  const tp = safeLower(type || "");
  const tg = safeLower(tag || "");
  const query = safeLower(q || "");
  const wantedIds = uniq(ids || [])
    .map(normalizeEquipmentId)
    .filter(Boolean);
  const wantedSet = wantedIds.length
    ? new Set(wantedIds.map((x) => EQUIPMENT_ALIAS_TO_ID[x] || x))
    : null;

  const items = Object.values(EQUIPMENT_BY_ID).filter((it) => {
    if (wantedSet && !wantedSet.has(it.id)) return false;
    if (cat && safeLower(it.category) !== cat) return false;
    if (tp && safeLower(it.type) !== tp) return false;
    if (tg && !(it.tags || []).some((t) => safeLower(t) === tg)) return false;
    if (query && !matchesQ(it, query)) return false;
    return true;
  });

  // stable sort: priority desc, then label asc
  items.sort((a, b) => {
    const pa = Number(a.priority) || 0;
    const pb = Number(b.priority) || 0;
    if (pb !== pa) return pb - pa;
    return String(a.label || "").localeCompare(String(b.label || ""));
  });

  return items;
}

function searchEquipment(q, { limit = 20 } = {}) {
  const query = safeLower(q || "");
  if (!query) return [];
  const items = listEquipment({ q: query });
  return items.slice(0, Math.max(1, Math.min(200, Number(limit) || 20)));
}

/**
 * Convert arbitrary user text (or parser token) into a canonical equipment id.
 * Returns "" if unknown.
 */
function resolveEquipmentIdFromText(text) {
  const key = normalizeEquipmentId(text);
  if (!key) return "";
  return EQUIPMENT_ALIAS_TO_ID[key] || (EQUIPMENT_BY_ID[key] ? key : "");
}

/**
 * Validate an equipment id exists in the catalog.
 */
function isKnownEquipmentId(id) {
  const x = resolveEquipmentIdFromText(id);
  return !!x;
}

export {
  VERSION as EQUIPMENT_CATALOG_VERSION,
  EQUIPMENT_CATALOG,
  EQUIPMENT_BY_ID,
  EQUIPMENT_ALIAS_TO_ID,
  normalizeEquipmentId,
  resolveEquipmentIdFromText,
  isKnownEquipmentId,
  getEquipment,
  listEquipment,
  searchEquipment,
};

export default EQUIPMENT_CATALOG;
