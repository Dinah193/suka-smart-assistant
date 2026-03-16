// src/services/nutrition/usdaDefaults.js
// USDA-style baseline + dynamic cuisine packs with aliasing, serving sizes,
// Passover/additive tags, and helpers to resolve/enrich.
//
// All nutrition values are approximate per 100 g unless noted.
// Units: Calories (kcal), Protein/Carbs/Fat/Fiber/Sugar (g), Sodium (mg), SatFat (g).

/* ----------------------------------------------------------------------------
   Defensive imports (optional logger; unit helpers; event bus / stores)
---------------------------------------------------------------------------- */
let logger = { info: () => {}, warn: () => {}, error: () => {} };
try {
  ({ logger } = await import("@/utils/logger"));
} catch {}

let toGrams, parseQty, roundN;
try {
  const math = await import("@/services/nutrition/nutritionMath");
  toGrams = math.toGrams;
  parseQty = math.parseQty;
  roundN = math.roundN;
} catch {
  toGrams = ({ qty = 0, unit }) => {
    const u = (unit || "").toLowerCase();
    const MASS_TO_G = {
      g: 1,
      gram: 1,
      grams: 1,
      kg: 1000,
      lb: 453.592,
      lbs: 453.592,
      oz: 28.3495,
    };
    return (MASS_TO_G[u] || 0) * (Number(qty) || 0);
  };
  parseQty = (q) => Number(q) || 0;
  roundN = (x, n = 0) => {
    const m = 10 ** n;
    return Math.round((x || 0) * m) / m;
  };
}

// Optional event bus / profile stores (best-effort)
let eventBus;
try {
  ({ eventBus } = await import("@/services/automation/eventBus"));
} catch {}
let usePreferencesStore, useHouseholdProfile;
try {
  ({ usePreferencesStore } = await import("@/store/PreferencesStore"));
} catch {}
try {
  ({ useHouseholdProfile } = await import("@/store/HouseholdProfileStore"));
} catch {}

/* ----------------------------------------------------------------------------
   Tag sets (for constraints & UX)
---------------------------------------------------------------------------- */
const TAGS = {
  chametz: new Set([
    "wheat",
    "rye",
    "barley",
    "spelt",
    "oats",
    "bread",
    "pasta",
    "beer",
    "leaven",
  ]),
  nonEarthAdditive: new Set([
    "artificial color",
    "artificial flavour",
    "artificial flavor",
    "red 40",
    "yellow 5",
    "blue 1",
    "caramel color",
    "sodium nitrite",
    "sodium benzoate",
    "potassium sorbate",
    "bht",
    "bha",
    "tbhq",
    "sucralose",
    "aspartame",
    "acesulfame k",
    "polysorbate 80",
    "propylene glycol",
    "msg",
  ]),
  westAfrican: new Set([
    "west-african",
    "egusi",
    "suya",
    "palm-oil",
    "fufu",
    "eba",
    "garri",
    "jollof",
    "waakye",
    "okra",
    "yam",
    "cassava",
    "millet",
  ]),
  africanAmerican: new Set([
    "african-american",
    "soul-food",
    "collards",
    "black-eyed-peas",
    "cornbread",
    "grits",
    "catfish",
    "okra-tomatoes",
    "sweet-potato",
    "smoked-turkey",
    "mac-and-cheese",
    "rice-and-gravy",
    "bbq",
  ]),
};

/* ----------------------------------------------------------------------------
   CORE reference table (per 100 g)
   Stable USDA-ish items any cuisine can rely on.
---------------------------------------------------------------------------- */
const CORE_REF_100G = {
  // --- Staples / grains ---
  "rice, cooked (white)": {
    Calories: 130,
    Protein: 2.7,
    Carbs: 28,
    Fat: 0.3,
    Fiber: 0.4,
    Sugar: 0.1,
    Sodium: 1,
    SatFat: 0.1,
    tags: ["grain"],
  },
  "rice, cooked (brown)": {
    Calories: 123,
    Protein: 2.6,
    Carbs: 25.6,
    Fat: 1.0,
    Fiber: 1.6,
    Sugar: 0.4,
    Sodium: 4,
    SatFat: 0.2,
    tags: ["grain", "whole-grain"],
  },
  "quinoa, cooked": {
    Calories: 120,
    Protein: 4.4,
    Carbs: 21.3,
    Fat: 1.9,
    Fiber: 2.8,
    Sugar: 0.9,
    Sodium: 7,
    SatFat: 0.2,
    tags: ["grain", "pseudo-grain", "gluten-free"],
  },
  "oats, dry": {
    Calories: 379,
    Protein: 13.2,
    Carbs: 67.7,
    Fat: 6.5,
    Fiber: 10.1,
    Sugar: 0.9,
    Sodium: 6,
    SatFat: 1.1,
    tags: ["grain", "whole-grain", "oats", "chametz"],
  },

  // --- Oils / fats ---
  "olive oil": {
    Calories: 884,
    Protein: 0,
    Carbs: 0,
    Fat: 100,
    Fiber: 0,
    Sugar: 0,
    Sodium: 2,
    SatFat: 14,
    tags: ["oil", "olive-oil", "mediterranean"],
  },

  // --- Nuts / seeds ---
  "peanuts, roasted": {
    Calories: 585,
    Protein: 25.8,
    Carbs: 16.1,
    Fat: 49.7,
    Fiber: 8.5,
    Sugar: 4.2,
    Sodium: 6,
    SatFat: 6.8,
    tags: ["nut"],
  },
  "almonds, raw": {
    Calories: 579,
    Protein: 21.2,
    Carbs: 21.7,
    Fat: 49.9,
    Fiber: 12.5,
    Sugar: 4.4,
    Sodium: 1,
    SatFat: 3.8,
    tags: ["nut"],
  },

  // --- Proteins ---
  "goat, cooked (diced)": {
    Calories: 143,
    Protein: 27,
    Carbs: 0,
    Fat: 3.0,
    Fiber: 0,
    Sugar: 0,
    Sodium: 65,
    SatFat: 1.0,
    tags: ["protein", "goat"],
  },
  "lamb, cooked (diced)": {
    Calories: 258,
    Protein: 25.6,
    Carbs: 0,
    Fat: 17,
    Fiber: 0,
    Sugar: 0,
    Sodium: 70,
    SatFat: 7.3,
    tags: ["protein", "lamb"],
  },
  "beef, cooked (diced)": {
    Calories: 250,
    Protein: 26,
    Carbs: 0,
    Fat: 15,
    Fiber: 0,
    Sugar: 0,
    Sodium: 72,
    SatFat: 6.0,
    tags: ["protein", "beef"],
  },
  "fish, cooked": {
    Calories: 150,
    Protein: 26,
    Carbs: 0,
    Fat: 4.0,
    Fiber: 0,
    Sugar: 0,
    Sodium: 60,
    SatFat: 1.0,
    tags: ["protein", "fish"],
  },
  "egg, whole": {
    Calories: 143,
    Protein: 12.6,
    Carbs: 1.1,
    Fat: 9.5,
    Fiber: 0,
    Sugar: 1.1,
    Sodium: 142,
    SatFat: 3.1,
    tags: ["protein", "egg"],
  },

  // --- Vegetables, greens, soups/stews ---
  "spinach, cooked": {
    Calories: 29,
    Protein: 3.0,
    Carbs: 3.8,
    Fat: 0.4,
    Fiber: 2.4,
    Sugar: 0.4,
    Sodium: 70,
    SatFat: 0.1,
    tags: ["veg", "greens"],
  },
  "greens, cooked (generic)": {
    Calories: 40,
    Protein: 3.0,
    Carbs: 7.0,
    Fat: 0.5,
    Fiber: 4.0,
    Sugar: 1.2,
    Sodium: 60,
    SatFat: 0.1,
    tags: ["veg", "greens"],
  },
  "okra, raw": {
    Calories: 33,
    Protein: 2.0,
    Carbs: 7.5,
    Fat: 0.2,
    Fiber: 3.2,
    Sugar: 1.5,
    Sodium: 7,
    SatFat: 0.0,
    tags: ["veg", "okra"],
  },

  // --- Fruits ---
  banana: {
    Calories: 89,
    Protein: 1.1,
    Carbs: 23,
    Fat: 0.3,
    Fiber: 2.6,
    Sugar: 12,
    Sodium: 1,
    SatFat: 0.1,
    tags: ["fruit"],
  },
  orange: {
    Calories: 47,
    Protein: 0.9,
    Carbs: 12,
    Fat: 0.1,
    Fiber: 2.4,
    Sugar: 9.4,
    Sodium: 0,
    SatFat: 0.0,
    tags: ["fruit"],
  },

  // --- Pantry / condiments ---
  "tomato, canned crushed": {
    Calories: 32,
    Protein: 1.7,
    Carbs: 7.0,
    Fat: 0.2,
    Fiber: 2.1,
    Sugar: 4.0,
    Sodium: 235,
    SatFat: 0.0,
    tags: ["veg", "tomato"],
  },
  "onion, chopped": {
    Calories: 40,
    Protein: 1.1,
    Carbs: 9.3,
    Fat: 0.1,
    Fiber: 1.7,
    Sugar: 4.2,
    Sodium: 4,
    SatFat: 0.0,
    tags: ["veg", "onion"],
  },

  // --- Dairy / alt ---
  "yogurt, plain (whole milk)": {
    Calories: 61,
    Protein: 3.5,
    Carbs: 4.7,
    Fat: 3.3,
    Fiber: 0,
    Sugar: 4.7,
    Sodium: 46,
    SatFat: 2.1,
    tags: ["dairy"],
  },
  "yogurt, plain (lowfat)": {
    Calories: 63,
    Protein: 5.3,
    Carbs: 7.0,
    Fat: 1.6,
    Fiber: 0,
    Sugar: 7.0,
    Sodium: 70,
    SatFat: 1.0,
    tags: ["dairy"],
  },
};

const CORE_SERVE_G = {
  "rice, cooked (white)": 150,
  "rice, cooked (brown)": 150,
  "quinoa, cooked": 140,
  "oats, dry": 40,

  "olive oil": 14,

  "peanuts, roasted": 28,
  "almonds, raw": 28,

  "goat, cooked (diced)": 85,
  "lamb, cooked (diced)": 85,
  "beef, cooked (diced)": 85,
  "fish, cooked": 85,
  "egg, whole": 50,

  "spinach, cooked": 85,
  "greens, cooked (generic)": 85,
  "okra, raw": 85,

  banana: 118,
  orange: 131,

  "tomato, canned crushed": 125,
  "onion, chopped": 110,

  "yogurt, plain (whole milk)": 170,
  "yogurt, plain (lowfat)": 170,
};

/* ----------------------------------------------------------------------------
   Cuisine Packs (per 100 g + serving sizes)
   - Default active: africanAmerican
   - Optional: westAfrican (enable via profile or API)
---------------------------------------------------------------------------- */
const PACKS = {
  africanAmerican: {
    ref100g: {
      // Greens & legumes
      "collard greens, cooked": {
        Calories: 33,
        Protein: 2.7,
        Carbs: 6.5,
        Fat: 0.6,
        Fiber: 4.0,
        Sugar: 0.5,
        Sodium: 25,
        SatFat: 0.1,
        tags: ["veg", "greens", "african-american", "soul-food", "collards"],
      },
      "black-eyed peas, cooked": {
        Calories: 116,
        Protein: 7.7,
        Carbs: 20.8,
        Fat: 0.5,
        Fiber: 6.3,
        Sugar: 3.3,
        Sodium: 2,
        SatFat: 0.1,
        tags: ["legume", "african-american", "soul-food", "black-eyed-peas"],
      },
      "okra & tomatoes (stewed)": {
        Calories: 38,
        Protein: 1.6,
        Carbs: 7.8,
        Fat: 0.3,
        Fiber: 2.2,
        Sugar: 3.6,
        Sodium: 260,
        SatFat: 0.1,
        tags: ["veg", "stew", "african-american", "okra-tomatoes", "okra"],
      },

      // Starches
      cornbread: {
        Calories: 330,
        Protein: 6.9,
        Carbs: 53.0,
        Fat: 8.0,
        Fiber: 2.0,
        Sugar: 14,
        Sodium: 660,
        SatFat: 1.5,
        tags: ["bread", "baked", "african-american", "soul-food", "chametz"],
      },
      "grits, cooked": {
        Calories: 71,
        Protein: 1.5,
        Carbs: 15.7,
        Fat: 0.2,
        Fiber: 0.7,
        Sugar: 0.1,
        Sodium: 0,
        SatFat: 0.0,
        tags: ["grain", "corn", "african-american", "grits", "gluten-free"],
      },
      "rice & gravy": {
        Calories: 140,
        Protein: 3.0,
        Carbs: 22.0,
        Fat: 4.2,
        Fiber: 0.4,
        Sugar: 0.6,
        Sodium: 240,
        SatFat: 1.3,
        tags: ["grain", "sauce", "african-american", "rice-and-gravy"],
      },
      "sweet potato, baked": {
        Calories: 90,
        Protein: 2.0,
        Carbs: 21.0,
        Fat: 0.1,
        Fiber: 3.3,
        Sugar: 6.5,
        Sodium: 36,
        SatFat: 0.0,
        tags: ["root", "sweet-potato", "african-american"],
      },

      // Proteins / mains
      "catfish, fried": {
        Calories: 229,
        Protein: 18.0,
        Carbs: 8.0,
        Fat: 13.0,
        Fiber: 0.7,
        Sugar: 0.0,
        Sodium: 360,
        SatFat: 2.5,
        tags: ["protein", "fish", "fried", "african-american", "catfish"],
      },
      "chicken, fried": {
        Calories: 260,
        Protein: 20.0,
        Carbs: 7.5,
        Fat: 16.0,
        Fiber: 0.6,
        Sugar: 0.1,
        Sodium: 490,
        SatFat: 4.0,
        tags: ["protein", "poultry", "fried", "african-american", "bbq"],
      },
      "chicken, baked": {
        Calories: 195,
        Protein: 29.0,
        Carbs: 0.0,
        Fat: 8.0,
        Fiber: 0.0,
        Sugar: 0.0,
        Sodium: 75,
        SatFat: 2.2,
        tags: ["protein", "poultry", "african-american"],
      },
      "smoked turkey (collard pot)": {
        Calories: 180,
        Protein: 26.0,
        Carbs: 0.0,
        Fat: 8.0,
        Fiber: 0.0,
        Sugar: 0.0,
        Sodium: 980,
        SatFat: 2.5,
        tags: ["protein", "poultry", "african-american", "smoked-turkey"],
      },

      // Sides
      "mac and cheese": {
        Calories: 166,
        Protein: 6.0,
        Carbs: 17.0,
        Fat: 8.0,
        Fiber: 0.7,
        Sugar: 2.0,
        Sodium: 330,
        SatFat: 4.5,
        tags: ["pasta", "cheese", "african-american", "soul-food", "chametz"],
      },
    },
    serveG: {
      "collard greens, cooked": 90,
      "black-eyed peas, cooked": 130,
      "okra & tomatoes (stewed)": 130,
      cornbread: 65, // ~1 square
      "grits, cooked": 140, // ~1 cup cooked ~ 242g; we choose modest plate portion
      "rice & gravy": 200,
      "sweet potato, baked": 150,
      "catfish, fried": 85,
      "chicken, fried": 85,
      "chicken, baked": 85,
      "smoked turkey (collard pot)": 56,
      "mac and cheese": 140,
    },
    aliases: {
      collards: "collard greens, cooked",
      "black eyed peas": "black-eyed peas, cooked",
      "okra & tomatoes": "okra & tomatoes (stewed)",
      "okra and tomatoes": "okra & tomatoes (stewed)",
      "mac & cheese": "mac and cheese",
      "mac n cheese": "mac and cheese",
      "rice and gravy": "rice & gravy",
      "fried catfish": "catfish, fried",
      "fried chicken": "chicken, fried",
      "baked chicken": "chicken, baked",
      "pot liquor turkey": "smoked turkey (collard pot)",
      "potlikker turkey": "smoked turkey (collard pot)",
      "corn bread": "cornbread",
      grits: "grits, cooked",
      "sweet potato": "sweet potato, baked",
    },
  },

  westAfrican: {
    ref100g: {
      "jollof rice": {
        Calories: 150,
        Protein: 3.0,
        Carbs: 27,
        Fat: 3.0,
        Fiber: 1.2,
        Sugar: 2.2,
        Sodium: 310,
        SatFat: 0.5,
        tags: ["west-african", "grain", "stewed-rice"],
      },
      "waakye (rice & beans)": {
        Calories: 146,
        Protein: 4.5,
        Carbs: 27,
        Fat: 1.3,
        Fiber: 5.0,
        Sugar: 0.5,
        Sodium: 15,
        SatFat: 0.3,
        tags: ["west-african", "grain", "legume"],
      },
      "millet, cooked": {
        Calories: 119,
        Protein: 3.5,
        Carbs: 23.7,
        Fat: 1.0,
        Fiber: 1.3,
        Sugar: 0.1,
        Sodium: 2,
        SatFat: 0.2,
        tags: ["west-african", "grain", "gluten-free"],
      },
      "fufu (cassava-based)": {
        Calories: 150,
        Protein: 1.0,
        Carbs: 36,
        Fat: 0.2,
        Fiber: 2.0,
        Sugar: 1.5,
        Sodium: 10,
        SatFat: 0.1,
        tags: ["west-african", "cassava", "gluten-free"],
      },
      "eba (garri hydrated)": {
        Calories: 155,
        Protein: 0.8,
        Carbs: 37,
        Fat: 0.2,
        Fiber: 2.1,
        Sugar: 1.5,
        Sodium: 12,
        SatFat: 0.1,
        tags: ["west-african", "cassava", "gluten-free"],
      },
      "cassava, raw": {
        Calories: 160,
        Protein: 1.4,
        Carbs: 38,
        Fat: 0.3,
        Fiber: 1.8,
        Sugar: 1.7,
        Sodium: 14,
        SatFat: 0.1,
        tags: ["root", "cassava", "west-african"],
      },
      "yam, boiled": {
        Calories: 116,
        Protein: 1.5,
        Carbs: 28,
        Fat: 0.1,
        Fiber: 3.9,
        Sugar: 0.5,
        Sodium: 7,
        SatFat: 0.0,
        tags: ["root", "yam", "west-african"],
      },
      "plantain, ripe fried": {
        Calories: 260,
        Protein: 1.7,
        Carbs: 35,
        Fat: 12,
        Fiber: 2.3,
        Sugar: 14,
        Sodium: 7,
        SatFat: 5.3,
        tags: ["plantain", "west-african"],
      },
      "palm oil": {
        Calories: 884,
        Protein: 0,
        Carbs: 0,
        Fat: 100,
        Fiber: 0,
        Sugar: 0,
        Sodium: 2,
        SatFat: 49,
        tags: ["west-african", "oil", "palm-oil"],
      },
      "egusi (melon seed), ground": {
        Calories: 593,
        Protein: 27,
        Carbs: 11,
        Fat: 48,
        Fiber: 3,
        Sugar: 1.5,
        Sodium: 30,
        SatFat: 8.0,
        tags: ["west-african", "seed", "egusi"],
      },
      "pepper soup (broth)": {
        Calories: 26,
        Protein: 2.0,
        Carbs: 3.0,
        Fat: 0.5,
        Fiber: 0.5,
        Sugar: 1.2,
        Sodium: 420,
        SatFat: 0.1,
        tags: ["west-african", "soup"],
      },
      "egusi stew (prepared)": {
        Calories: 130,
        Protein: 7.0,
        Carbs: 4.0,
        Fat: 9.0,
        Fiber: 1.5,
        Sugar: 1.2,
        Sodium: 220,
        SatFat: 2.5,
        tags: ["west-african", "stew", "egusi"],
      },
    },
    serveG: {
      "jollof rice": 200,
      "waakye (rice & beans)": 200,
      "millet, cooked": 140,
      "fufu (cassava-based)": 180,
      "eba (garri hydrated)": 180,
      "cassava, raw": 100,
      "yam, boiled": 150,
      "plantain, ripe fried": 100,
      "palm oil": 14,
      "egusi (melon seed), ground": 30,
      "pepper soup (broth)": 240,
      "egusi stew (prepared)": 180,
    },
    aliases: {
      jollof: "jollof rice",
      waakye: "waakye (rice & beans)",
      oats: "oats, dry",
      fufu: "fufu (cassava-based)",
      eba: "eba (garri hydrated)",
      garri: "eba (garri hydrated)",
      cassava: "cassava, raw",
      yam: "yam, boiled",
      "palm-oil": "palm oil",
      suya: "suya spice (dry rub)", // retained for future spice pack
      "pepper soup": "pepper soup (broth)",
    },
  },
};

/* ----------------------------------------------------------------------------
   Aliases (global) – start with neutral/common terms; cuisine packs add more.
---------------------------------------------------------------------------- */
const GLOBAL_ALIASES = {
  // grains
  "white rice cooked": "rice, cooked (white)",
  "brown rice cooked": "rice, cooked (brown)",
  "cooked rice": "rice, cooked (white)",
  oats: "oats, dry",

  // proteins
  goat: "goat, cooked (diced)",
  lamb: "lamb, cooked (diced)",
  beef: "beef, cooked (diced)",
  fish: "fish, cooked",
  egg: "egg, whole",

  // veg
  okra: "okra, raw",
  spinach: "spinach, cooked",
  greens: "greens, cooked (generic)",

  // fruits
  "banana (medium)": "banana",
  "orange (medium)": "orange",

  // pantry
  "tomato crushed": "tomato, canned crushed",
  onion: "onion, chopped",

  // dairy
  yogurt: "yogurt, plain (whole milk)",

  // oils
  "olive-oil": "olive oil",
};

/* ----------------------------------------------------------------------------
   Active tables (rebuilt from CORE + active cuisine packs)
---------------------------------------------------------------------------- */
let REF_100G = {};
let SERVE_G = {};
let ALIASES = {}; // merged GLOBAL + active pack aliases

// Default cuisine packs: African-American (as requested)
let ACTIVE_PACKS = new Set(["africanAmerican"]);

function rebuildActiveTables() {
  REF_100G = { ...CORE_REF_100G };
  SERVE_G = { ...CORE_SERVE_G };
  ALIASES = { ...GLOBAL_ALIASES };

  for (const key of ACTIVE_PACKS) {
    const pack = PACKS[key];
    if (!pack) continue;
    // merge ref100g
    for (const [k, v] of Object.entries(pack.ref100g || {})) {
      // merge tags preserving uniqueness
      const base = REF_100G[k] || {};
      const mergedTags = new Set([...(base.tags || []), ...(v.tags || [])]);
      REF_100G[k] = { ...base, ...v, tags: [...mergedTags] };
    }
    // merge serving sizes
    Object.assign(SERVE_G, pack.serveG || {});
    // merge aliases
    Object.assign(ALIASES, pack.aliases || {});
  }

  logger.info?.(
    "[usdaDefaults] rebuilt tables from packs",
    Array.from(ACTIVE_PACKS)
  );
}

// Build initial tables
rebuildActiveTables();

/* ----------------------------------------------------------------------------
   Utilities
---------------------------------------------------------------------------- */
const toKey = (s) => (s || "").toString().trim().toLowerCase();

function findCanonical(name) {
  if (!name) return null;
  const key = toKey(name);
  // direct hit
  for (const k of Object.keys(REF_100G)) {
    if (toKey(k) === key) return k;
  }
  // alias hit
  for (const [alias, canonical] of Object.entries(ALIASES)) {
    if (toKey(alias) === key) return canonical;
  }
  // fuzzy contains
  for (const k of Object.keys(REF_100G)) {
    if (key.includes(toKey(k))) return k;
    if (toKey(k).includes(key)) return k;
  }
  // fuzzy aliases (contains)
  for (const [alias, canonical] of Object.entries(ALIASES)) {
    if (key.includes(toKey(alias))) return canonical;
  }
  return null;
}

/* ----------------------------------------------------------------------------
   Public API
---------------------------------------------------------------------------- */

/**
 * Resolve a food name to a ref:
 *  { key, per100g, servingGrams, tags:[], isChametz, isWestAfrican, isAfricanAmerican }
 */
export function resolve(name) {
  const canonical = findCanonical(name);
  if (!canonical) return null;
  const per100g = REF_100G[canonical] || {};
  const servingGrams = SERVE_G[canonical] || 100;
  const tags = new Set(per100g.tags || []);

  const canonicalKeyLC = toKey(canonical);
  const isWestAfrican =
    [...TAGS.westAfrican].some((t) => tags.has(t)) ||
    /jollof|waakye|egusi|suya|fufu|eba|garri|palm oil|okra|yam|cassava|millet/i.test(
      canonical
    );
  const isAfricanAmerican =
    [...TAGS.africanAmerican].some((t) => tags.has(t)) ||
    /collard|black-eyed|okra.*tomatoes|cornbread|grits|catfish|mac.*cheese|smoked turkey|rice & gravy|sweet potato/i.test(
      canonicalKeyLC
    );

  const isChametz =
    tags.has("chametz") ||
    [...TAGS.chametz].some((t) => canonicalKeyLC.includes(t));

  return {
    key: canonical,
    per100g,
    servingGrams,
    tags: [...tags],
    isChametz,
    isWestAfrican,
    isAfricanAmerican,
  };
}

/**
 * Get per-quantity macros by looking up the ref and scaling:
 * e.g. nutrientsFor("jollof rice", { qty: 1, unit: "cup" }, { densityGPerCup: 195 })
 */
export function nutrientsFor(
  name,
  { qty = 1, unit = "g", densityGPerCup } = {}
) {
  const ref = resolve(name);
  if (!ref) return null;

  let grams = 0;

  if (typeof toGrams === "function") {
    grams = toGrams({ qty: parseQty(qty), unit, name, densityGPerCup });
  } else {
    grams = toGrams({ qty, unit });
  }
  if (!grams || grams <= 0) {
    const u = (unit || "").toLowerCase();
    if (u === "serving" || u === "piece")
      grams = ref.servingGrams * (Number(qty) || 1);
  }
  if (!grams || grams <= 0) grams = ref.servingGrams;

  const scale = grams / 100;
  const p = ref.per100g;
  const out = {
    Calories: roundN(p.Calories * scale, 0),
    Protein: roundN(p.Protein * scale, 1),
    Carbs: roundN(p.Carbs * scale, 1),
    Fat: roundN(p.Fat * scale, 1),
    Fiber: roundN(p.Fiber * scale, 1),
    Sugar: roundN(p.Sugar * scale, 1),
    Sodium: roundN(p.Sodium * scale, 0),
    SatFat: roundN(p.SatFat * scale, 1),
  };
  return { grams, ...out };
}

/**
 * Enrich a list of recipe ingredients with per-gram nutrition references.
 */
export function enrichIngredients(ingredients = []) {
  return (ingredients || []).map((ing) => {
    const out = { ...(ing || {}) };
    const ref = resolve(out.name);
    if (!ref) return out;

    out.nutritionPer = "100g";
    out.servingGrams = ref.servingGrams;
    out.tags = Array.from(new Set([...(out.tags || []), ...(ref.tags || [])]));

    if (out.grams == null) {
      try {
        out.grams = toGrams({
          qty: parseQty(out.qty),
          unit: out.unit,
          name: out.name,
        });
      } catch {
        /* ignore */
      }
    }
    out.nutrition = ref.per100g;
    return out;
  });
}

/**
 * Merge overrides into the reference table at runtime (brand items, lab results, etc.)
 * override = { key: "jollof rice", per100g: { ... }, servingGrams: 220, tags: [] }
 */
export function mergeOverride(override = {}) {
  if (!override?.key) throw new Error("mergeOverride: missing key");
  const key = override.key;

  const base = REF_100G[key] || {};
  if (override.per100g) {
    const mergedTags = new Set([
      ...(base.tags || []),
      ...(override.per100g.tags || []),
    ]);
    REF_100G[key] = { ...base, ...override.per100g, tags: [...mergedTags] };
  }
  if (override.servingGrams) SERVE_G[key] = override.servingGrams;
  if (Array.isArray(override.tags)) {
    const t = new Set(REF_100G[key]?.tags || []);
    override.tags.forEach((x) => t.add(x));
    REF_100G[key].tags = [...t];
  }
  logger.info?.("[usdaDefaults] merged override", key);
  return resolve(key);
}

/**
 * Add an alias (street name → canonical key)
 */
export function addAlias(alias, canonicalKey) {
  if (!REF_100G[canonicalKey])
    throw new Error(`Unknown canonical key: ${canonicalKey}`);
  ALIASES[toKey(alias)] = canonicalKey;
  return true;
}

/**
 * Search reference keys by substring/tag
 */
export function search({ q = "", tag } = {}) {
  const needle = toKey(q);
  const keys = Object.keys(REF_100G);
  let res = keys;
  if (needle) res = res.filter((k) => toKey(k).includes(needle));
  if (tag) res = res.filter((k) => (REF_100G[k].tags || []).includes(tag));
  return res.map((k) => ({
    key: k,
    servingGrams: SERVE_G[k] || 100,
    per100g: REF_100G[k],
  }));
}

/**
 * Quick predicate helpers
 */
export function isChametzKey(key) {
  const k = toKey(key);
  if (!REF_100G[key]) return false;
  const tags = new Set(REF_100G[key].tags || []);
  if (tags.has("unleavened")) return false;
  return [...TAGS.chametz].some((t) => k.includes(t)) || tags.has("chametz");
}
export function isWestAfricanKey(key) {
  const tags = new Set(REF_100G[key]?.tags || []);
  return [...TAGS.westAfrican].some((t) => tags.has(t));
}
export function isAfricanAmericanKey(key) {
  const tags = new Set(REF_100G[key]?.tags || []);
  return [...TAGS.africanAmerican].some((t) => tags.has(t));
}

/* ----------------------------------------------------------------------------
   Dynamic cuisine control
---------------------------------------------------------------------------- */

/**
 * Replace active cuisine packs (e.g., ["africanAmerican"], ["westAfrican"], or both).
 * Triggers rebuild of tables.
 */
export function setActiveCuisinePacks(packs = []) {
  ACTIVE_PACKS = new Set(packs.filter((p) => PACKS[p]));
  rebuildActiveTables();
  return Array.from(ACTIVE_PACKS);
}

/** Read back which cuisine packs are currently active. */
export function getActiveCuisinePacks() {
  return Array.from(ACTIVE_PACKS);
}

/**
 * Apply Household Profile or Preferences to cuisine activation.
 * Looks for likely fields but is tolerant of shape differences.
 *
 * Expected examples:
 * - profile.cuisineDefaults = ["africanAmerican","westAfrican"]
 * - profile.cuisine.primary = "africanAmerican"
 * - preferences.food.cuisines.active = [...]
 * If not found, defaults to ["africanAmerican"].
 */
export function applyHouseholdProfile(profileOrPrefs = {}) {
  let next = null;

  const p = profileOrPrefs || {};
  // Try multiple shapes based on your project conventions
  if (Array.isArray(p.cuisineDefaults)) next = p.cuisineDefaults;
  else if (p.cuisine?.active && Array.isArray(p.cuisine.active))
    next = p.cuisine.active;
  else if (typeof p.cuisine?.primary === "string") next = [p.cuisine.primary];
  else if (p.food?.cuisines?.active && Array.isArray(p.food.cuisines.active))
    next = p.food.cuisines.active;

  if (!next || next.length === 0) next = ["africanAmerican"];
  setActiveCuisinePacks(next);
  logger.info?.("[usdaDefaults] applyHouseholdProfile -> packs", next);
  return getActiveCuisinePacks();
}

/* ----------------------------------------------------------------------------
   Auto-subscribe to profile / preferences updates when available
---------------------------------------------------------------------------- */
(function bootstrapListeners() {
  try {
    // Event bus path (best effort)
    if (eventBus?.on) {
      eventBus.on("household.profile.updated", (payload) => {
        try {
          applyHouseholdProfile(payload?.profile || payload);
        } catch (e) {
          logger.warn?.("profile.updated handler", e);
        }
      });
      eventBus.on("preferences.cuisine.updated", (payload) => {
        try {
          applyHouseholdProfile(payload?.preferences || payload);
        } catch (e) {
          logger.warn?.("cuisine.updated handler", e);
        }
      });
    }

    // Store watchers (best effort)
    if (typeof useHouseholdProfile === "function") {
      const unsub = useHouseholdProfile.subscribe?.((state) => {
        try {
          applyHouseholdProfile(state);
        } catch (e) {
          logger.warn?.("useHouseholdProfile.subscribe", e);
        }
      });
      // optional: expose for tests/debug
      // eslint-disable-next-line no-unused-vars
      const _unsubProfile = unsub;
    }
    if (typeof usePreferencesStore === "function") {
      const unsub2 = usePreferencesStore.subscribe?.((state) => {
        const cuisines = state?.food?.cuisines;
        if (cuisines) {
          try {
            applyHouseholdProfile({ food: { cuisines } });
          } catch (e) {
            logger.warn?.("usePreferencesStore.subscribe", e);
          }
        }
      });
      // eslint-disable-next-line no-unused-vars
      const _unsubPrefs = unsub2;
    }

    // Initial pull from stores (best effort)
    if (typeof usePreferencesStore === "function") {
      const st = usePreferencesStore.getState?.();
      if (st?.food?.cuisines?.active)
        applyHouseholdProfile({ food: { cuisines: st.food.cuisines } });
    } else if (typeof useHouseholdProfile === "function") {
      const hp = useHouseholdProfile.getState?.();
      if (hp) applyHouseholdProfile(hp);
    } else {
      // ensure default applied
      setActiveCuisinePacks(["africanAmerican"]);
    }
  } catch (e) {
    logger.warn?.("[usdaDefaults] bootstrapListeners error", e);
  }
})();

/* ----------------------------------------------------------------------------
   Export namespace
---------------------------------------------------------------------------- */
export const usdaDefaults = {
  resolve,
  nutrientsFor,
  enrichIngredients,
  mergeOverride,
  addAlias,
  search,
  isChametzKey,
  isWestAfricanKey,
  isAfricanAmericanKey,
  setActiveCuisinePacks,
  getActiveCuisinePacks,
  applyHouseholdProfile,
};

export default usdaDefaults;
