/* recipeNormalizer.js
   Units & servings standardization for Suka recipes.

   What this does:
   - Tokenizes ingredient lines into { quantity, unit, name, note, original }
   - Normalizes units to a canonical map (tsp, tbsp, cup, g, kg, ml, l, oz, lb)
   - Converts between metric/US/hybrid with sensible rounding
   - Scales ingredients and recalculates macros-per-serving safely
   - Optional volume<->mass conversion for selected ingredients (using approx. densities)
   - Pretty-prints normalized ingredient lines for UI

   Exports:
     - normalizeRecipe(recipe, opts) -> normalized recipe object (non-destructive)
     - normalizeIngredients(ingredients, opts) -> array of tokenized+normalized items
     - scaleRecipe(recipe, targetServings, opts) -> scaled copy
     - unitConvert(qty, fromUnit, toUnit, { ingredient }) -> { qty, unit }
     - formatIngredient(token, opts) -> string
     - parseIngredientLine(line) -> token  (exported for convenience)

   Notes:
     - Defensive: never throws; returns best-effort results.
     - Densities are approximate; only used if you ask for cross-domain conversions (e.g. cups flour -> grams).
     - Hybrid strategy tries to use small-spoon units for tiny quantities and grams for most else.
*/

/* -------------------------------- Utilities -------------------------------- */
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, Number(n) || 0));
const toNum = (x) => (x == null || x === "" ? undefined : Number(x));
const isFiniteNum = (n) => typeof n === "number" && Number.isFinite(n);
const toArray = (x) => (Array.isArray(x) ? x : x != null ? [x] : []);

/* Fractions (unicode & ascii) -> decimal */
const FRACTIONS = {
  "¼": 0.25, "½": 0.5, "¾": 0.75,
  "⅐": 1/7, "⅑": 1/9, "⅒": 0.1, "⅓": 1/3, "⅔": 2/3, "⅕": 0.2, "⅖": 0.4, "⅗": 0.6, "⅘": 0.8,
  "⅙": 1/6, "⅚": 5/6, "⅛": 0.125, "⅜": 0.375, "⅝": 0.625, "⅞": 0.875,
};
function parseFraction(s) {
  if (!s) return undefined;
  let acc = 0;
  let rest = s;
  for (const k of Object.keys(FRACTIONS)) {
    if (rest.includes(k)) {
      acc += FRACTIONS[k];
      rest = rest.replace(k, " ");
    }
  }
  // handle "1 1/2" or "1/2"
  const m = rest.match(/(\d+)\s+(\d+)\/(\d+)/) || rest.match(/(\d+)\/(\d+)/);
  if (m) {
    if (m.length === 4) {
      acc += parseInt(m[1], 10) + parseInt(m[2], 10) / parseInt(m[3], 10);
    } else if (m.length === 3) {
      acc += parseInt(m[1], 10) / parseInt(m[2], 10);
    }
  } else {
    // lone integer/decimal
    const n = Number(rest.trim());
    if (isFiniteNum(n)) acc += n;
  }
  return acc || undefined;
}

/* --------------------------------- Units ----------------------------------- */
/* Canonical unit map and aliases */
const CANON = {
  // volume (US)
  tsp: { kind: "vol", to_ml: 4.92892159375 },
  tbsp:{ kind: "vol", to_ml: 14.78676478125 },
  cup: { kind: "vol", to_ml: 236.5882365 },
  floz:{ kind: "vol", to_ml: 29.5735295625 },
  pint:{ kind: "vol", to_ml: 473.176473 },
  quart:{kind: "vol", to_ml: 946.352946 },
  gallon:{kind: "vol", to_ml: 3785.411784 },

  // volume (metric)
  ml:  { kind: "vol", to_ml: 1 },
  l:   { kind: "vol", to_ml: 1000 },

  // mass
  g:   { kind: "mass", to_g: 1 },
  kg:  { kind: "mass", to_g: 1000 },
  oz:  { kind: "mass", to_g: 28.349523125 },
  lb:  { kind: "mass", to_g: 453.59237 },

  // count-ish (no direct conversion, we keep as-is)
  piece:{ kind: "count" },
  clove:{ kind: "count" },
  can:  { kind: "count" },
  stick:{ kind: "count" },
  slice:{ kind: "count" },
  pinch:{ kind: "count" },
  dash: { kind: "count" },
};

const ALIASES = new Map([
  // spoons
  ["t", "tsp"], ["tsp", "tsp"], ["teaspoon","tsp"], ["teaspoons","tsp"],
  ["tbsp","tbsp"], ["T","tbsp"], ["tablespoon","tbsp"], ["tablespoons","tbsp"],
  // cups
  ["c","cup"], ["cup","cup"], ["cups","cup"],
  // fluid ounce
  ["fl oz","floz"], ["fl. oz","floz"], ["fluid ounce","floz"], ["fluid ounces","floz"], ["ounce (fluid)","floz"], ["ounces (fluid)","floz"],
  // pints/quarts/gallons
  ["pt","pint"], ["pint","pint"], ["pints","pint"],
  ["qt","quart"], ["quart","quart"], ["quarts","quart"],
  ["gal","gallon"], ["gallon","gallon"], ["gallons","gallon"],
  // metric vols
  ["milliliter","ml"], ["milliliters","ml"], ["ml","ml"],
  ["liter","l"], ["litre","l"], ["liters","l"], ["litres","l"], ["l","l"],
  // mass
  ["g","g"], ["gram","g"], ["grams","g"],
  ["kg","kg"], ["kilogram","kg"], ["kilograms","kg"],
  ["oz","oz"], ["ounce","oz"], ["ounces","oz"],
  ["lb","lb"], ["lbs","lb"], ["pound","lb"], ["pounds","lb"],
  // count
  ["piece","piece"], ["pieces","piece"], ["clove","clove"], ["cloves","clove"],
  ["can","can"], ["cans","can"], ["stick","stick"], ["sticks","stick"],
  ["slice","slice"], ["slices","slice"], ["pinch","pinch"], ["dash","dash"],
]);

/* Densities (approx, at room temp). grams per milliliter. */
const DENSITY_G_PER_ML = {
  water: 1.0,
  milk: 1.03,
  oil: 0.91,           // generic veg oil
  butter: 0.911,       // by vol (melted)
  sugar: 0.85,         // granulated
  brown_sugar: 0.72,   // packed
  flour: 0.53,         // AP flour (scooped)
  rice: 0.85,          // uncooked long-grain (approx)
  honey: 1.42,
  maple_syrup: 1.32,
  salt: 1.20,          // table salt
};

/* Lightweight matcher to map ingredient name to density key */
function densityKeyFor(ingredient = "") {
  const s = String(ingredient).toLowerCase();
  if (/all[-\s]?purpose flour|ap flour|flour/.test(s)) return "flour";
  if (/brown sugar/.test(s)) return "brown_sugar";
  if (/sugar/.test(s)) return "sugar";
  if (/butter/.test(s)) return "Butter".toLowerCase();
  if (/oil/.test(s)) return "oil";
  if (/honey/.test(s)) return "honey";
  if (/maple/.test(s)) return "maple_syrup";
  if (/milk/.test(s)) return "milk";
  if (/salt/.test(s)) return "salt";
  if (/rice/.test(s)) return "rice";
  if (/water/.test(s)) return "water";
  return null;
}

/* --------------------------- Tokenize an ingredient ------------------------- */
function parseIngredientLine(line) {
  const original = String(line || "").trim();

  // capture leading quantity (supports "1 1/2", "½", "1-2", "about 2")
  const qtyMatch = original.match(/^\s*(?:about\s+|approx\.?\s+|around\s+)?([(\d][^a-zA-Z]*)/);
  let quantity;
  let rest = original;

  if (qtyMatch) {
    const raw = qtyMatch[1]
      .replace(/[()]/g, " ")
      .replace(/\s*-\s*/g, " "); // treat ranges loosely
    quantity = parseFraction(raw);
    if (isFiniteNum(quantity)) {
      rest = original.slice(qtyMatch[0].length).trim();
    }
  }

  // unit next
  let unit;
  // allow "heaping tbsp", "rounded tsp"
  const unitMatch = rest.match(/^(heaping|rounded|level)?\s*([a-zA-Z. ]{1,15})\b/);
  if (unitMatch) {
    const rawUnit = unitMatch[2].toLowerCase().replace(/\./g, "").trim();
    const aliased = ALIASES.get(rawUnit);
    if (aliased && CANON[aliased]) {
      unit = aliased;
      rest = rest.slice(unitMatch[0].length).trim();
    }
  }

  // name + trailing note in comma/parentheses
  let name = rest.trim();
  let note;
  const paren = name.match(/\(([^)]+)\)\s*$/);
  if (paren) {
    note = paren[1].trim();
    name = name.slice(0, paren.index).trim();
  }
  const comma = name.match(/,\s*(.*)$/);
  if (comma) {
    note = (note ? note + "; " : "") + comma[1].trim();
    name = name.slice(0, comma.index).trim();
  }

  // fallback: if unit was not detected but looks like unit at start of name
  if (!unit) {
    const maybeUnit = (name.match(/^([a-zA-Z. ]{1,15})\b/) || [])[1];
    const aliased = maybeUnit && ALIASES.get(maybeUnit.toLowerCase().replace(/\./g, "").trim());
    if (aliased && CANON[aliased]) {
      unit = aliased;
      name = name.slice(maybeUnit.length).trim();
    }
  }

  return { original, quantity, unit, name, note };
}

/* ---------------------------- Unit conversions ----------------------------- */
function isSameKind(u1, u2) {
  if (!u1 || !u2) return false;
  const a = CANON[u1]; const b = CANON[u2];
  return a && b && a.kind === b.kind;
}

function toBase(qty, unit) {
  // base: ml for volume, g for mass
  if (!isFiniteNum(qty) || !unit || !CANON[unit]) return { qty, unit };
  const u = CANON[unit];
  if (u.kind === "vol") return { qty: qty * u.to_ml, unit: "ml" };
  if (u.kind === "mass") return { qty: qty * u.to_g, unit: "g" };
  return { qty, unit };
}

function fromBase(qty, targetUnit) {
  if (!isFiniteNum(qty) || !targetUnit || !CANON[targetUnit]) return { qty, unit: targetUnit };
  const u = CANON[targetUnit];
  if (u.kind === "vol") return { qty: qty / u.to_ml, unit: targetUnit };
  if (u.kind === "mass") return { qty: qty / u.to_g, unit: targetUnit };
  return { qty, unit: targetUnit };
}

/* Convert across types using density if provided/known */
function convertAcrossKinds(qty, fromUnit, toUnit, { ingredient } = {}) {
  const from = CANON[fromUnit]; const to = CANON[toUnit];
  if (!from || !to || from.kind === to.kind) return { qty, unit: toUnit };

  const key = densityKeyFor(ingredient);
  const rho = key ? DENSITY_G_PER_ML[key] : null;
  if (!rho) return { qty, unit: fromUnit }; // refuse unsafe conversion

  if (from.kind === "vol" && to.kind === "mass") {
    // ml -> g via rho
    const { qty: ml } = toBase(qty, fromUnit);
    return fromBase(ml * rho, toUnit);
  }
  if (from.kind === "mass" && to.kind === "vol") {
    const { qty: g } = toBase(qty, fromUnit);
    return fromBase(g / rho, toUnit);
  }
  return { qty, unit: fromUnit };
}

/* Public convert helper */
function unitConvert(qty, fromUnit, toUnit, { ingredient } = {}) {
  if (!isFiniteNum(qty) || !fromUnit || !toUnit) return { qty, unit: toUnit || fromUnit };
  if (fromUnit === toUnit) return { qty, unit: toUnit };

  const a = CANON[fromUnit], b = CANON[toUnit];
  if (!a || !b) return { qty, unit: toUnit }; // unknown: return raw

  if (isSameKind(fromUnit, toUnit)) {
    const { qty: base } = toBase(qty, fromUnit);
    return fromBase(base, toUnit);
  }
  // cross-kind
  return convertAcrossKinds(qty, fromUnit, toUnit, { ingredient });
}

/* ------------------------------ Strategy & rules ---------------------------- */
const DEFAULTS = {
  preferredSystem: "hybrid", // "metric" | "us" | "hybrid"
  // convert volumes of these ingredients to grams in metric/hybrid for precision
  convertVolumesToMassFor: ["flour", "sugar", "brown_sugar", "butter", "rice"],
  // minimum quantity to switch to next bigger/smaller unit (to keep human-friendly)
  thresholds: {
    tsp_to_tbsp: 3.0,  // >=3 tsp -> 1 tbsp
    tbsp_to_cup: 16.0, // >=16 tbsp -> 1 cup
    ml_to_l: 1000,
    g_to_kg: 1000,
    floz_to_cup: 8.0,
    oz_to_lb: 16.0,
  },
  round: {
    small: 1/8,  // round to nearest 1/8 for small spoon measures
    default: 1,  // nearest 1 (grams/ml) default
  },
  targetServings: null, // if provided, scale to this
  recalcMacros: true,   // recompute per-serving macros if servings change
};

/* Round to a given step (e.g., 0.125 => 1/8) */
function roundToStep(n, step) {
  if (!isFiniteNum(n)) return n;
  return Math.round(n / step) * step;
}

/* Choose a pleasant unit for display given base qty+unit and strategy */
function chooseDisplayUnit(baseQty, baseUnit, token, cfg) {
  const sys = cfg.preferredSystem;
  const t = cfg.thresholds;

  if (baseUnit === "ml") {
    if (sys === "metric") {
      if (baseQty >= t.ml_to_l) return { qty: baseQty / 1000, unit: "l" };
      return { qty: baseQty, unit: "ml" };
    }

    // US / Hybrid: use cups/tbsp/tsp ladder
    const cups = baseQty / CANON.cup.to_ml;
    if (cups >= 1) return { qty: cups, unit: "cup" };

    const tbsp = baseQty / CANON.tbsp.to_ml;
    if (tbsp >= 1) {
      // if >= 3 tbsp convert to tbsp; else maybe tsp
      if (tbsp < 3) {
        const tsp = baseQty / CANON.tsp.to_ml;
        if (tsp >= 1) return { qty: tsp, unit: "tsp" };
      }
      return { qty: tbsp, unit: "tbsp" };
    }

    const tsp = baseQty / CANON.tsp.to_ml;
    if (tsp >= 1) return { qty: tsp, unit: "tsp" };

    // tiny volume: keep ml in hybrid to avoid “pinch” guessing
    return sys === "hybrid" ? { qty: baseQty, unit: "ml" } : { qty: tsp, unit: "tsp" };
  }

  if (baseUnit === "g") {
    if (sys === "us") {
      // try oz for larger masses
      const oz = baseQty / CANON.oz.to_g;
      const lb = baseQty / CANON.lb.to_g;
      if (lb >= 1) return { qty: lb, unit: "lb" };
      if (oz >= 1) return { qty: oz, unit: "oz" };
      // small mass: hybrid fallback to grams (precision)
      return { qty: baseQty, unit: "g" };
    }
    // metric/hybrid
    if (baseQty >= DEFAULTS.thresholds.g_to_kg) return { qty: baseQty / 1000, unit: "kg" };
    return { qty: baseQty, unit: "g" };
  }

  return { qty: baseQty, unit: baseUnit };
}

/* ------------------------ Normalize a single token -------------------------- */
function normalizeToken(token, cfg) {
  const out = { ...token };
  const sys = cfg.preferredSystem;

  // Canonicalize unit
  let unit = token.unit;
  if (unit) {
    const aliased = ALIASES.get(String(unit).toLowerCase().replace(/\./g, "").trim());
    if (aliased && CANON[aliased]) {
      unit = aliased;
    }
  }

  let qty = token.quantity;

  // Cross-kind conversion for selected ingredients in metric/hybrid:
  if (unit && token.name) {
    const dKey = densityKeyFor(token.name);
    const wantsMass = (sys !== "us") && cfg.convertVolumesToMassFor.includes(dKey || "");
    const wantsVol = (sys === "us") && CANON[unit]?.kind === "mass" && /ml|l/.test(unit) === false; // rare case
    if (wantsMass && CANON[unit]?.kind === "vol") {
      const { qty: base } = toBase(qty || 0, unit); // ml
      const converted = convertAcrossKinds((qty || 0), unit, "g", { ingredient: token.name });
      qty = converted.qty;
      unit = converted.unit;
    } else if (wantsVol && CANON[unit]?.kind === "mass") {
      const converted = convertAcrossKinds((qty || 0), unit, "ml", { ingredient: token.name });
      qty = converted.qty;
      unit = converted.unit;
    }
  }

  // Go to base
  if (unit && CANON[unit]?.kind === "vol") {
    const { qty: ml } = toBase(qty || 0, unit);
    const disp = chooseDisplayUnit(ml, "ml", token, cfg);
    qty = disp.qty;
    unit = disp.unit;
  } else if (unit && CANON[unit]?.kind === "mass") {
    const { qty: g } = toBase(qty || 0, unit);
    const disp = chooseDisplayUnit(g, "g", token, cfg);
    qty = disp.qty;
    unit = disp.unit;
  }

  // Rounding strategy
  const roundStep =
    (unit === "tsp" || unit === "tbsp") ? cfg.round.small
    : (unit === "cup" || unit === "ml" || unit === "g" || unit === "oz") ? cfg.round.default
    : cfg.round.default;

  if (isFiniteNum(qty)) qty = roundToStep(qty, roundStep);

  return {
    ...out,
    quantity: qty,
    unit,
  };
}

/* ------------------------- Format an ingredient token ----------------------- */
function formatQty(qty, unit) {
  if (!isFiniteNum(qty)) return "";
  // Pretty fractions for small values when using spoons or cups
  const isSpoon = unit === "tsp" || unit === "tbsp" || unit === "cup";
  if (isSpoon) {
    // Convert decimals like 0.125 -> 1/8
    const step = 1/8;
    const n = roundToStep(qty, step);
    const whole = Math.floor(n);
    const frac = n - whole;

    const toFrac = (f) => {
      const num = Math.round(f / step);
      if (num === 0) return "";
      const map = {1:"1/8",2:"1/4",3:"3/8",4:"1/2",5:"5/8",6:"3/4",7:"7/8",8:"1"};
      return map[num] || f.toFixed(2);
    };

    const fracStr = toFrac(frac);
    if (whole && fracStr && fracStr !== "1") return `${whole} ${fracStr}`;
    if (!whole && fracStr) return fracStr;
    if (fracStr === "1") return String(whole + 1);
    return String(whole);
  }
  // Default: integers for grams/ml, 1 decimal for oz/lb
  if (unit === "g" || unit === "ml") return String(Math.round(qty));
  if (unit === "kg" || unit === "l" || unit === "oz" || unit === "lb") return qty.toFixed(qty < 10 ? 1 : 0);
  return String(qty);
}

function unitLabel(unit, qty) {
  if (!unit) return "";
  // very light pluralization
  const plural = (n) => (Math.abs(n - 1) < 1e-9 ? "" : "s");
  switch (unit) {
    case "tsp": return `tsp${plural(qty)}`;
    case "tbsp": return `tbsp${plural(qty)}`;
    case "cup": return `cup${plural(qty)}`;
    case "ml": return "ml";
    case "l": return "l";
    case "g": return "g";
    case "kg": return "kg";
    case "oz": return "oz";
    case "lb": return "lb";
    case "floz": return `fl oz`;
    case "pint": return `pint${plural(qty)}`;
    case "quart": return `quart${plural(qty)}`;
    case "gallon": return `gallon${plural(qty)}`;
    // count-ish
    case "piece": return `piece${plural(qty)}`;
    case "clove": return `clove${plural(qty)}`;
    case "can": return `can${plural(qty)}`;
    case "stick": return `stick${plural(qty)}`;
    case "slice": return `slice${plural(qty)}`;
    case "pinch": return `pinch${plural(qty)}`;
    case "dash": return `dash${plural(qty)}`;
    default: return unit;
  }
}

function formatIngredient(token, opts = {}) {
  const t = token || {};
  const qtyStr = isFiniteNum(t.quantity) ? formatQty(t.quantity, t.unit) : "";
  const unitStr = t.unit ? unitLabel(t.unit, t.quantity) : "";
  const parts = [qtyStr, unitStr, t.name].filter(Boolean).join(" ");
  return t.note ? `${parts}, ${t.note}` : parts || t.original || "";
}

/* --------------------------- Normalize ingredients -------------------------- */
function normalizeIngredients(ingredients = [], options = {}) {
  const cfg = { ...DEFAULTS, ...options };
  const out = [];

  for (const line of ingredients) {
    // Line may already be tokenized (object) or string
    const token = typeof line === "string" ? parseIngredientLine(line) : { ...line };
    if (!token.name && !token.unit && !isFiniteNum(token.quantity)) {
      // skip empties but preserve original text
      out.push({ original: String(line || ""), name: String(line || "") });
      continue;
    }
    const normalized = normalizeToken(token, cfg);
    normalized.display = formatIngredient(normalized, cfg);
    out.push(normalized);
  }
  return out;
}

/* ------------------------------- Recipe scale ------------------------------- */
function scaleIngredients(tokens = [], fromServings, toServings) {
  if (!isFiniteNum(fromServings) || !isFiniteNum(toServings) || fromServings <= 0) return tokens;
  const factor = toServings / fromServings;
  return tokens.map((t) => {
    const q = isFiniteNum(t.quantity) ? t.quantity * factor : t.quantity;
    return { ...t, quantity: q };
  });
}

function scaleMacros(macros = {}, fromServings, toServings) {
  if (!macros || !fromServings || !toServings) return macros || {};
  // macros in your extractor are per serving when possible. We keep them as per-serving values.
  // If recipe specifies totals, you can put a `macrosTotal` bag and recompute per serving here.
  return { ...macros }; // assume per-serving; no change
}

/* ---------------------------- Normalize a recipe ---------------------------- */
function normalizeRecipe(recipe = {}, options = {}) {
  const cfg = { ...DEFAULTS, ...options };
  const baseServings = toNum(recipe.servings) || toNum(recipe.yield) || undefined;
  const targetServings = isFiniteNum(cfg.targetServings) ? cfg.targetServings : baseServings;

  // 1) Ingredients
  const normalizedIng = normalizeIngredients(recipe.ingredients || [], cfg);
  const scaledIng = (isFiniteNum(baseServings) && isFiniteNum(targetServings) && baseServings !== targetServings)
    ? scaleIngredients(normalizedIng, baseServings, targetServings)
    : normalizedIng;

  // Rebuild display after scaling
  const scaledWithDisplay = scaledIng.map((t) => ({
    ...t,
    display: formatIngredient(t, cfg),
  }));

  // 2) Macros (per serving)
  let macros = recipe.macros || {};
  if (cfg.recalcMacros && isFiniteNum(baseServings) && isFiniteNum(targetServings) && baseServings !== targetServings) {
    macros = scaleMacros(macros, baseServings, targetServings);
  }

  // 3) Times (unchanged), Title, etc. — pass through
  const out = {
    ...recipe,
    servings: targetServings ?? baseServings ?? recipe.servings,
    yieldText: targetServings && baseServings && targetServings !== baseServings
      ? `${targetServings} servings`
      : (recipe.yieldText || recipe.servings ? `${recipe.servings} servings` : recipe.yieldText),
    ingredients: scaledWithDisplay.map((t) => t.display || t.original || "").filter(Boolean),
    // keep structured tokens for Inventory/Grocery
    ingredientsTokens: scaledWithDisplay,
    macros, // per serving (as in extractor)
    unitSystem: cfg.preferredSystem,
    _normalization: {
      scaledFromServings: baseServings,
      scaledToServings: targetServings,
      strategy: cfg.preferredSystem,
      convertedByDensity: cfg.convertVolumesToMassFor,
    },
  };

  return out;
}

/* ------------------------------- Public scale ------------------------------- */
function scaleRecipe(recipe = {}, targetServings, options = {}) {
  return normalizeRecipe(recipe, { ...options, targetServings });
}

/* ---------------------------------- Exports --------------------------------- */
module.exports = {
  // core
  normalizeRecipe,
  normalizeIngredients,
  scaleRecipe,
  // helpers
  parseIngredientLine,
  unitConvert,
  formatIngredient,
  // internals exposed for tests
  _internals: {
    CANON,
    ALIASES,
    DENSITY_G_PER_ML,
    densityKeyFor,
    toBase,
    fromBase,
    convertAcrossKinds,
    chooseDisplayUnit,
    roundToStep,
  },
};
