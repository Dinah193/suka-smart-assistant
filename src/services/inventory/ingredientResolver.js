// src/services/inventory/ingredientResolver.js
// Ingredient Resolver (dynamic, event-aware, coalescing, price-aware)
//
// v2 adds:
// - resolveCoalesced(list): dedup by slug, sum qty/grams, merge flags, pick best vendor
// - Smart substitutions v2: respects prefs (dietary/budget/passover), pantry-first, macro deltas
// - Price estimation via Vendors price maps (if available)
// - Reactive listeners: cuisine pack changes & favorites/profile updates
// - Learning hook: emit favorites.learn for repeated nicknames
// - Micro LRU cache for single resolve
//
// C) Cuisine bias integration
// - Reads cuisine bias from PreferencesStore at resolve-time
// - Listens to household.profile.updated and primes usdaDefaults bias immediately
// - Default/fallback cuisine bias: ["african-american"]

/* ----------------------------------------------------------------------------
   Defensive optional imports
---------------------------------------------------------------------------- */
let logger = { info() {}, warn() {}, error() {} };
let usdaDefaults, setCuisineBiasFn, nutritionMath, Inventory, Vendors;
let PreferencesStore, HouseholdProfile, FavoritesStore;
let eventBus, automation;

try {
  ({ logger } = await import("@/utils/logger"));
} catch {}
try {
  // Pull both resolver and the new cuisine setter
  ({ usdaDefaults, setCuisineBias: setCuisineBiasFn } = await import(
    "@/services/nutrition/usdaDefaults"
  ));
} catch {}
try {
  nutritionMath = await import("@/services/nutrition/nutritionMath");
} catch {}
try {
  ({ Inventory } = await import("@/store/InventoryStore"));
} catch {}
try {
  ({ Vendors } = await import("@/store/VendorStore"));
} catch {}
try {
  ({ usePreferencesStore: PreferencesStore } = await import(
    "@/store/PreferencesStore"
  ));
} catch {}
try {
  ({ useHouseholdProfile: HouseholdProfile } = await import(
    "@/store/HouseholdProfileStore"
  ));
} catch {}
try {
  ({ useFavoritesStore: FavoritesStore } = await import(
    "@/store/FavoritesStore"
  ));
} catch {}
try {
  ({ eventBus } = await import("@/services/automation/eventBus"));
} catch {}
try {
  ({ automation } = await import("@/services/automation/runtime"));
} catch {}

const DEFAULT_AISLE = "Other";
const DEFAULT_STORE = "Any";

/* ----------------------------------------------------------------------------
   Policy/Tags & Prefs Keys
---------------------------------------------------------------------------- */
const PASSOVER_TAGS = new Set([
  "chametz",
  "leaven",
  "leavening-agent",
  "bread",
  "pasta",
  "beer",
  "waffle",
  "pancake",
  "barley",
  "wheat",
  "rye",
  "oats",
  "spelt",
]);

const ALLERGENS = [
  "peanut",
  "tree nut",
  "almond",
  "walnut",
  "cashew",
  "pecan",
  "pistachio",
  "hazelnut",
  "egg",
  "milk",
  "dairy",
  "soy",
  "wheat",
  "gluten",
  "fish",
  "shellfish",
  "sesame",
];

const PREF_KEYS = {
  dietary: "food.dietary", // e.g., { pescatarian:true, dairyFree:false, porkFree:true }
  budget: "food.budget", // e.g., { perWeek: 150, priceSensitivity: "high" }
  cuisines: "household.cuisineBias", // <— lives under household; array of tags
  passover: "calendar.sabbathGuard", // you may have a separate explicit passover flag elsewhere
};

/* ----------------------------------------------------------------------------
   Density Hints (g per cup unless noted)
---------------------------------------------------------------------------- */
const DENSITY_HINTS = {
  "tomato, canned crushed": 240,
  "onion, chopped": 160,
  "okra sliced": 160,
  "spinach cooked": 180,
  "rice cooked": 195,
  "jollof rice": 195,
  "millet cooked": 174,
  "quinoa cooked": 170,
  "olive oil": 218,
  "palm oil": 218,
  yogurt: 245,
  "beans cooked": 175,
  "lentils cooked": 198,
  "mac and cheese": 220,
};

/* ----------------------------------------------------------------------------
   Favorites-aware alias cache + learning counters
---------------------------------------------------------------------------- */
let FAVORITE_ALIASES = {}; // "nana pudding" -> "banana pudding"
const NICK_LEARN = new Map(); // alias -> count before we emit learn event
const LEARN_THRESHOLD = 3;

function rebuildFavoriteAliases() {
  try {
    const favs = FavoritesStore?.getState?.()?.food?.favorites || [];
    FAVORITE_ALIASES = {};
    for (const f of favs) {
      const canonical = f.canonicalKey || f.name;
      if (!canonical) continue;
      const aliases = Array.from(new Set([f.name, ...(f.aliases || [])]))
        .map((a) => toKey(a))
        .filter(Boolean);
      for (const a of aliases) FAVORITE_ALIASES[a] = canonical;
    }
    logger.info?.(
      "[ingredientResolver] favorite aliases rebuilt",
      Object.keys(FAVORITE_ALIASES).length
    );
  } catch (e) {
    logger.warn?.("[ingredientResolver] rebuildFavoriteAliases failed", e);
  }
}

// Subscribe once if available
try {
  FavoritesStore?.subscribe?.(rebuildFavoriteAliases);
  HouseholdProfile?.subscribe?.(() => rebuildFavoriteAliases());
  rebuildFavoriteAliases();
} catch {}

/* ----------------------------------------------------------------------------
   Micro LRU cache (last 64 items)
---------------------------------------------------------------------------- */
const LRU = new Map();
function lruGet(key) {
  if (!LRU.has(key)) return;
  const v = LRU.get(key);
  LRU.delete(key);
  LRU.set(key, v);
  return v;
}
function lruSet(key, val) {
  LRU.set(key, val);
  if (LRU.size > 64) {
    const k = LRU.keys().next().value;
    LRU.delete(k);
  }
}

/* ----------------------------------------------------------------------------
   Helpers: Math & Formatting
---------------------------------------------------------------------------- */
function round(x, n = 0) {
  const p = 10 ** n;
  return Math.round((Number(x) || 0) * p) / p;
}
function slugify(s = "") {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}
const toKey = (s) => (s || "").toString().trim().toLowerCase();

function toNumberOrFraction(s) {
  if (!s && s !== 0) return 0;
  if (typeof s === "number") return s;
  let str = String(s).trim();
  if (!str) return 0;
  const UNI = {
    "½": "1/2",
    "⅓": "1/3",
    "⅔": "2/3",
    "¼": "1/4",
    "¾": "3/4",
    "⅛": "1/8",
    "⅜": "3/8",
    "⅝": "5/8",
    "⅞": "7/8",
  };
  str = str.replace(/[½⅓⅔¼¾⅛⅜⅝⅞]/g, (m) => UNI[m] || m);
  str = str.replace(/(\d+)x(\d+)/i, "$1 x $2");
  if (/\d+\s+\d+\/\d+/.test(str)) {
    const [a, b] = str.split(/\s+/);
    const [n, d] = b.split("/").map(Number);
    return Number(a) + (d ? n / d : 0);
  }
  if (/^\d+\/\d+$/.test(str)) {
    const [n, d] = str.split("/").map(Number);
    return d ? n / d : 0;
  }
  if (/^\d+\s*-\s*\d+$/.test(str)) {
    const [a, b] = str.split("-").map(Number);
    return (a + b) / 2;
  }
  const n = Number(str);
  return Number.isFinite(n) ? n : 0;
}

function normUnit(u = "") {
  const s = String(u || "")
    .toLowerCase()
    .replace(/\./g, "");
  if (!s) return "";
  const map = {
    tsp: "tsp",
    teaspoon: "tsp",
    teaspoons: "tsp",
    tbsp: "tbsp",
    tablespoon: "tbsp",
    tablespoons: "tbsp",
    cup: "cup",
    cups: "cup",
    g: "g",
    gram: "g",
    grams: "g",
    kg: "kg",
    ml: "ml",
    milliliter: "ml",
    milliliters: "ml",
    l: "l",
    liter: "l",
    liters: "l",
    oz: "oz",
    ounce: "oz",
    ounces: "oz",
    "fl oz": "floz",
    floz: "floz",
    can: "can",
    cans: "can",
    piece: "piece",
    pieces: "piece",
    pc: "piece",
    pcs: "piece",
    clove: "piece",
    cloves: "piece",
    stick: "stick",
    sticks: "stick",
    lb: "lb",
    lbs: "lb",
    pound: "lb",
    pounds: "lb",
  };
  return map[s] || s;
}

/* ----------------------------------------------------------------------------
   Parsing
---------------------------------------------------------------------------- */
function normalizeInput(obj = {}) {
  const qty = toNumberOrFraction(obj.qty);
  const unit = normUnit(obj.unit);
  const name = String(obj.name || obj.raw || "").trim();
  const sizeText = obj.sizeText || "";
  const tags = Array.isArray(obj.tags) ? obj.tags : [];
  return {
    // FIX: correct template string for raw
    raw: obj.raw || `${qty || ""} ${unit || ""} ${name}`.trim(),
    displayName: obj.displayName || null,
    qty,
    unit,
    name,
    sizeText,
    tags,
    brand: obj.brand || null,
    barcode: obj.barcode || obj.upc || null,
  };
}

function parseLine(line = "") {
  const raw = String(line).trim();
  const paren = /\(([^)]+)\)/.exec(raw);
  const sizeText = paren ? paren[1] : "";
  const withoutParen = raw.replace(/\(([^)]+)\)/g, "").trim();
  const multMatch =
    /(?<mult>\d+)\s*[xX]\s*(?<pack>\d+(?:\.\d+)?)\s*[- ]?\s*(?<packUnit>oz|g|ml)\b/.exec(
      withoutParen
    );
  let packQty = 0,
    packUnit = "",
    packSizeGrams = 0;
  if (multMatch?.groups) {
    packQty = Number(multMatch.groups.mult);
    packUnit = multMatch.groups.packUnit.toLowerCase();
    packSizeGrams = toSizeInGrams(Number(multMatch.groups.pack), packUnit);
  }
  const rx =
    /^(?<qty>\d+(?:\s+\d+\/\d+)?|\d*\/\d+)?\s*(?<unit>[a-zA-Z\.]+)?\s*(?<name>.+)$/;
  const m = rx.exec(withoutParen);
  let qty = 0,
    unit = "",
    name = withoutParen;
  if (m?.groups) {
    qty = toNumberOrFraction(m.groups.qty);
    unit = normUnit(m.groups.unit);
    name = (m.groups.name || "").trim();
  }
  if (!qty && /^\d+$/.test(sizeText) && /egg|eggs/i.test(raw)) {
    qty = Number(sizeText);
    unit = "piece";
  }
  name = name.replace(/\b(of|x)\b/gi, " ").trim();
  let computedSizeGrams = 0;
  if (packQty && packSizeGrams) computedSizeGrams = packQty * packSizeGrams;
  else if (sizeText) {
    const g = sizeToGrams(sizeText);
    if (g) computedSizeGrams = g;
  }
  return { raw, qty, unit, name, sizeText, tags: [], computedSizeGrams };
}

function toSizeInGrams(amount, unit) {
  switch (unit) {
    case "g":
      return amount;
    case "ml":
      return amount;
    case "oz":
      return amount * 28.3495;
    default:
      return 0;
  }
}
function sizeToGrams(txt = "") {
  const oz = /(\d+(?:\.\d+)?)\s*oz/i.exec(txt);
  const g = /(\d+(?:\.\d+)?)\s*g\b/i.exec(txt);
  const ml = /(\d+(?:\.\d+)?)\s*ml\b/i.exec(txt);
  if (g) return Number(g[1]);
  if (ml) return Number(ml[1]);
  if (oz) return Number(oz[1]) * 28.3495;
  return 0;
}

/* ----------------------------------------------------------------------------
   Canonical & density lookup (favorites first, then cuisine/global)
---------------------------------------------------------------------------- */
function resolveCanonical(name = "") {
  if (!name) return null;
  const low = name.toLowerCase();

  // favorites-first
  if (FAVORITE_ALIASES[toKey(name)]) {
    const favKey = FAVORITE_ALIASES[toKey(name)];
    const favRef = usdaDefaults?.resolve?.(favKey);
    if (favRef) return favRef;
  }

  // main resolver (cuisine bias already set upstream)
  const ref = usdaDefaults?.resolve?.(name);
  if (ref) return ref;

  // conservative fallbacks
  if (low.includes("crushed tomato"))
    return (
      usdaDefaults?.resolve?.("tomato, canned crushed") || {
        key: "tomato, canned crushed",
      }
    );
  if (low.includes("onion"))
    return (
      usdaDefaults?.resolve?.("onion, chopped") || { key: "onion, chopped" }
    );
  if (low.includes("jollof"))
    return usdaDefaults?.resolve?.("jollof rice") || { key: "jollof rice" };
  if (low.includes("olive oil"))
    return usdaDefaults?.resolve?.("olive oil") || { key: "olive oil" };
  if (low.includes("palm oil"))
    return usdaDefaults?.resolve?.("palm oil") || { key: "palm oil" };
  if (low.includes("yogurt"))
    return (
      usdaDefaults?.resolve?.("yogurt, plain (whole milk)") || {
        key: "yogurt, plain (whole milk)",
      }
    );

  // nickname learning
  const k = toKey(name);
  const count = (NICK_LEARN.get(k) || 0) + 1;
  NICK_LEARN.set(k, count);
  if (count === LEARN_THRESHOLD) {
    try {
      automation?.emit?.("favorites.learn", { alias: name });
    } catch {}
  }

  return { key: name };
}

function guessDensity(name = "") {
  const n = name.toLowerCase();
  for (const k of Object.keys(DENSITY_HINTS))
    if (n.includes(k.toLowerCase())) return DENSITY_HINTS[k];
  if (/oil/.test(n)) return 218;
  if (/rice/.test(n)) return 195;
  if (/quinoa/.test(n)) return 170;
  if (/millet/.test(n)) return 174;
  if (/yogurt/.test(n)) return 245;
  return null;
}

/* ----------------------------------------------------------------------------
   Grams & macros
---------------------------------------------------------------------------- */
function estimateGrams(parsed, canonical) {
  const densityGPerCup = guessDensity(canonical?.key || parsed.name);
  if (parsed.computedSizeGrams > 0) {
    const unitIsPack =
      parsed.unit === "can" || parsed.unit === "piece" || !parsed.unit;
    if (unitIsPack)
      return round((parsed.qty || 1) * parsed.computedSizeGrams, 0);
  }
  try {
    const g = nutritionMath?.toGrams?.({
      qty: parsed.qty || 1,
      unit: parsed.unit || "g",
      name: canonical?.key || parsed.name,
      densityGPerCup,
    });
    if (g && g > 0) return round(g, 0);
  } catch {}
  if (canonical?.servingGrams)
    return round((parsed.qty || 1) * canonical.servingGrams, 0);
  return 0;
}

function scalePer100g(per100g = {}, grams = 0) {
  const s = grams / 100;
  return {
    Calories: round((per100g.Calories || 0) * s, 0),
    Protein: round((per100g.Protein || 0) * s, 1),
    Carbs: round((per100g.Carbs || 0) * s, 1),
    Fat: round((per100g.Fat || 0) * s, 1),
    Fiber: round((per100g.Fiber || 0) * s, 1),
    Sugar: round((per100g.Sugar || 0) * s, 1),
    Sodium: round((per100g.Sodium || 0) * s, 0),
    SatFat: round((per100g.SatFat || 0) * s, 1),
  };
}
function emptyMacros() {
  return {
    Calories: 0,
    Protein: 0,
    Carbs: 0,
    Fat: 0,
    Fiber: 0,
    Sugar: 0,
    Sodium: 0,
    SatFat: 0,
  };
}

/* ----------------------------------------------------------------------------
   Flags (Passover, additives, allergens)
---------------------------------------------------------------------------- */
function computeFlags(parsed, canonical, passoverMode) {
  const name = (canonical?.key || parsed.name || "").toLowerCase();
  const tags = new Set(
    [...(canonical?.tags || []), ...(parsed.tags || [])].map((t) =>
      String(t).toLowerCase()
    )
  );
  const passoverRestricted =
    !!passoverMode &&
    ([...PASSOVER_TAGS].some((t) => tags.has(t)) ||
      /(bread|pasta|barley|wheat|rye|beer|oats|spelt)/.test(name));
  let additivesFlag = 0;
  try {
    additivesFlag =
      nutritionMath?.additiveRiskScore?.({ name, tags: [...tags] }) ?? 0;
  } catch {
    additivesFlag = 0;
  }
  const allergens = ALLERGENS.filter((a) => name.includes(a) || tags.has(a));
  return { passoverRestricted, additivesFlag, allergens };
}
function isPassover(ing) {
  const nm = (ing?.name || "").toLowerCase();
  const tg = new Set((ing?.tags || []).map((x) => String(x).toLowerCase()));
  return (
    [...PASSOVER_TAGS].some((t) => tg.has(t)) ||
    /(bread|pasta|barley|wheat|rye|beer|oats|spelt)/.test(nm)
  );
}

/* ----------------------------------------------------------------------------
   Inventory + substitutions
---------------------------------------------------------------------------- */
function matchInventory(keyName, inventory) {
  const slug = slugify(keyName);
  const items = inventory?.items || [];
  const exact = items.find((i) => slugify(i.slug || i.name) === slug);
  if (exact) return summarizeInvItem(exact);
  const head = slug.split(" ")[0];
  const near = items.find((i) => slugify(i.slug || i.name).startsWith(head));
  if (near) return summarizeInvItem(near);
  return null;
}
function summarizeInvItem(i) {
  const lots = Array.isArray(i.lots)
    ? i.lots.map((l) => ({
        qty: l.qty || 0,
        location: l.location || i.location || "pantry",
        expires: l.expires || null,
      }))
    : [{ qty: i.qty || 0, location: i.location || "pantry", expires: null }];
  const total = lots.reduce((a, b) => a + (b.qty || 0), 0);
  return { slug: slugify(i.slug || i.name), name: i.name, qty: total, lots };
}

// Smart subs v2: pantry-first, dietary/passover constraints, macro distance
function suggestSubs(
  invMatch,
  inventory,
  passoverMode,
  dietaryPrefs,
  targetMacrosPer100g
) {
  if (!inventory?.items?.length) return [];
  const head = invMatch ? invMatch.slug.split(" ")[0] : null;
  const candidates = [];
  for (const it of inventory.items) {
    const sl = slugify(it.slug || it.name);
    if (invMatch && sl === invMatch.slug) continue;
    if (head && !sl.startsWith(head)) continue;

    const total = Array.isArray(it.lots)
      ? it.lots.reduce((a, b) => a + (b.qty || 0), 0)
      : it.qty || 0;
    if (total <= 0) continue;

    if (passoverMode && isPassover({ name: it.name })) continue;
    if (!passesDiet(it.name, dietaryPrefs)) continue;

    let macroDistance = 0;
    try {
      const ref = usdaDefaults?.resolve?.(it.name);
      if (ref && targetMacrosPer100g) {
        const p = ref.per100g || {};
        macroDistance =
          Math.abs((p.Protein || 0) - (targetMacrosPer100g.Protein || 0)) +
          Math.abs((p.Carbs || 0) - (targetMacrosPer100g.Carbs || 0)) +
          Math.abs((p.Fat || 0) - (targetMacrosPer100g.Fat || 0));
      }
    } catch {}
    candidates.push({
      slug: sl,
      name: it.name,
      qty: total,
      location: it.location || "pantry",
      macroDistance,
    });
  }
  return candidates
    .sort((a, b) => a.macroDistance - b.macroDistance)
    .slice(0, 6);
}

function passesDiet(name, dietaryPrefs = {}) {
  const n = (name || "").toLowerCase();
  if (dietaryPrefs?.porkFree && /(pork|bacon|ham)/i.test(n)) return false;
  if (dietaryPrefs?.dairyFree && /(milk|cheese|yogurt|butter|cream)/i.test(n))
    return false;
  if (
    dietaryPrefs?.pescatarian &&
    /(beef|lamb|goat|pork|chicken|turkey)/i.test(n)
  )
    return false;
  // Extend as needed (vegan, nut-free, etc.)
  return true;
}

/* ----------------------------------------------------------------------------
   Vendors: aisle + price estimation
---------------------------------------------------------------------------- */
function assignStoreAisle(name, vendors) {
  const catalog = buildVendorCatalog(vendors);
  let chosen = catalog[0];
  let aisle = DEFAULT_AISLE;
  let price = null;

  for (const store of catalog) {
    for (const a of store.aisles) {
      const match = a.matchers?.some((rx) => rx.test(name)) || false;
      if (match) {
        chosen = store;
        aisle = a.name;
        break;
      }
    }
  }

  // price map shape (optional): store.priceMap[slug|canonicalKey] = { unit:"g"|"piece"|"can", pricePerUnit, packSize? }
  try {
    const pm = chosen.priceMap || {};
    const key = toKey(name);
    const hit = pm[key];
    if (hit) price = { storeId: chosen.id, storeName: chosen.name, ...hit };
  } catch {}

  return {
    storeId: chosen.id,
    storeName: chosen.name,
    aisle,
    estimated: price,
  };
}

function buildVendorCatalog(vendors = []) {
  const out = [];
  for (const v of vendors) {
    const aisles = (v.aisles || []).map((a) => ({
      name: a.name || DEFAULT_AISLE,
      matchers: (a.match || []).map((m) =>
        m instanceof RegExp ? m : new RegExp(String(m), "i")
      ),
    }));
    out.push({
      id: v.id || v.name || DEFAULT_STORE,
      name: v.name || DEFAULT_STORE,
      priority: v.priority ?? 5,
      aisles: aisles.length ? aisles : [{ name: DEFAULT_AISLE, matchers: [] }],
      priceMap: v.priceMap || null,
    });
  }
  if (!out.length)
    out.push({
      id: DEFAULT_STORE,
      name: DEFAULT_STORE,
      priority: 9,
      aisles: [{ name: DEFAULT_AISLE, matchers: [] }],
    });
  return out.sort((a, b) => a.priority - b.priority);
}

function estimateItemPrice(routing, grams, qty = 1) {
  const est = routing?.estimated;
  if (!est) return null;
  const unit = (est.unit || "g").toLowerCase();
  if (unit === "g") return round((est.pricePerUnit || 0) * (grams || 0), 2);
  if (unit === "piece" || unit === "can")
    return round((est.pricePerUnit || 0) * (qty || 1), 2);
  if (unit === "kg")
    return round(((est.pricePerUnit || 0) * (grams || 0)) / 1000, 2);
  return null;
}

/* ----------------------------------------------------------------------------
   Reserve Signals
---------------------------------------------------------------------------- */
async function emitReserveSignal(payload) {
  try {
    if (automation?.emit)
      await automation.emit("inventory.reserve.requested", payload);
    else if (eventBus?.emit)
      eventBus.emit("inventory.reserve.requested", payload);
  } catch (e) {
    logger.warn?.("[ingredientResolver] emitReserveSignal failed", e);
  }
}

/* ----------------------------------------------------------------------------
   Cuisine bias helpers (C)
---------------------------------------------------------------------------- */
function primeCuisineBiasFromPrefs() {
  try {
    if (!setCuisineBiasFn) return;
    const prefs = PreferencesStore?.getState?.() || {};
    const tags = getIn(prefs, PREF_KEYS.cuisines) || [];
    const normalized = (Array.isArray(tags) ? tags : [])
      .map((t) => t?.tag || t)
      .filter(Boolean);
    // Fallback to AA if nothing set
    setCuisineBiasFn(normalized.length ? normalized : ["african-american"]);
  } catch (e) {
    logger.warn?.("[ingredientResolver] primeCuisineBiasFromPrefs failed", e);
  }
}

/* ----------------------------------------------------------------------------
   Public API
---------------------------------------------------------------------------- */
export const ingredientResolver = {
  /**
   * Resolve a single ingredient.
   */
  async resolve(input, options = {}) {
    // Ensure cuisine bias is primed before resolving canonicals
    primeCuisineBiasFromPrefs();

    const cacheKey = JSON.stringify({
      input,
      options: { ...options, vendors: undefined },
    }); // ignore large vendor objs in key
    const cached = lruGet(cacheKey);
    if (cached) return cached;

    const prefs = PreferencesStore?.getState?.() || {};
    // If you track a dedicated passover flag, substitute here:
    const passoverMode = options.passoverMode ?? false;
    const dietaryPrefs = getIn(prefs, PREF_KEYS.dietary) || {};

    const parsed =
      typeof input === "string" ? parseLine(input) : normalizeInput(input);
    const canonical = resolveCanonical(parsed.name);

    const grams = estimateGrams(parsed, canonical);
    const nutrit = canonical ? usdaDefaults?.resolve?.(canonical.key) : null;
    const macroQuick = nutrit
      ? scalePer100g(nutrit.per100g, grams)
      : emptyMacros();
    const flags = computeFlags(parsed, canonical, passoverMode);

    const inventory = options.householdId
      ? await Inventory?.snapshot?.(options.householdId).catch(() => null)
      : null;

    const invMatch = inventory
      ? matchInventory(canonical?.key || parsed.name, inventory)
      : null;
    const substitutes = inventory
      ? suggestSubs(
          invMatch,
          inventory,
          passoverMode,
          dietaryPrefs,
          nutrit?.per100g
        )
      : [];

    const vendors =
      options.vendors ||
      (await Vendors?.list?.().catch(() => [])) ||
      getDefaultVendors();
    const routing = assignStoreAisle(canonical?.key || parsed.name, vendors);
    const estimatedPrice = estimateItemPrice(routing, grams, parsed.qty || 1);

    const out = {
      raw: parsed.raw,
      name: canonical?.key || parsed.name,
      displayName: parsed.displayName || canonical?.key || parsed.name,
      slug: slugify(canonical?.key || parsed.name),
      qty: parsed.qty,
      unit: parsed.unit,
      sizeText: parsed.sizeText || null,
      grams,
      densityGPerCup: guessDensity(canonical?.key || parsed.name),
      per100g: nutrit?.per100g || null,
      perItemMacros: macroQuick,
      servingGrams: nutrit?.servingGrams || null,
      tags: Array.from(
        new Set([...(nutrit?.tags || []), ...(parsed.tags || [])])
      ),
      passoverRestricted: !!flags.passoverRestricted,
      additivesFlag: flags.additivesFlag,
      allergens: flags.allergens,
      inventory: invMatch,
      substitutes,
      vendor: routing.storeName,
      aisle: routing.aisle,
      vendorRouting: routing,
      estimatedPrice,
      brand: parsed.brand || null,
      barcode: parsed.barcode || null,
      cuisine: {
        africanAmerican: !!nutrit?.isAfricanAmerican,
        westAfrican: !!nutrit?.isWestAfrican,
      },
    };

    if (options.emitReserve && invMatch) {
      await emitReserveSignal({
        householdId: options.householdId,
        itemSlug: out.slug,
        qty: out.qty ?? 1,
        grams: out.grams,
        context: options.reserveContext || {},
      });
    }

    lruSet(cacheKey, out);
    return out;
  },

  /**
   * Resolve a list then **coalesce** by slug:
   * - sums qty/grams
   * - merges flags (any=true)
   * - picks cheapest eligible store (if price maps exist)
   * Returns { items:[...], totals:{ grams, price }, stores:[{storeName, total}] }
   */
  async resolveCoalesced(list, options = {}) {
    const resolved = await this.resolveList(list, options);
    const bySlug = new Map();
    for (const it of resolved) {
      const key = it.slug;
      if (!bySlug.has(key))
        bySlug.set(key, { ...it, priceBreakdown: {}, _count: 0 });
      const acc = bySlug.get(key);
      acc.qty = (acc.qty || 0) + (it.qty || 0);
      acc.grams = (acc.grams || 0) + (it.grams || 0);
      acc.passoverRestricted = !!(
        acc.passoverRestricted || it.passoverRestricted
      );
      acc.additivesFlag = Math.max(
        acc.additivesFlag || 0,
        it.additivesFlag || 0
      );
      acc.allergens = Array.from(
        new Set([...(acc.allergens || []), ...(it.allergens || [])])
      );
      acc._count += 1;

      // accumulate per store price when available
      const est = it.vendorRouting?.estimated;
      const price = estimateItemPrice(it.vendorRouting, it.grams, it.qty || 1);
      if (est && price != null) {
        const store = it.vendorRouting.storeName;
        acc.priceBreakdown[store] = round(
          (acc.priceBreakdown[store] || 0) + price,
          2
        );
      }
    }

    // choose best store for each
    const items = [];
    const storeTotals = {};
    for (const acc of bySlug.values()) {
      let bestStore = acc.vendor;
      let bestPrice = null;
      for (const [store, sum] of Object.entries(acc.priceBreakdown)) {
        if (bestPrice == null || sum < bestPrice) {
          bestPrice = sum;
          bestStore = store;
        }
      }
      const final = {
        ...acc,
        vendor: bestStore,
        estimatedPrice: bestPrice ?? acc.estimatedPrice,
      };
      delete final._count;
      items.push(final);
      if (final.estimatedPrice != null) {
        storeTotals[final.vendor] = round(
          (storeTotals[final.vendor] || 0) + final.estimatedPrice,
          2
        );
      }
    }

    const totals = {
      grams: round(
        items.reduce((a, b) => a + (b.grams || 0), 0),
        0
      ),
      price: Object.values(storeTotals).reduce((a, b) => a + b, 0),
    };
    const stores = Object.entries(storeTotals)
      .map(([storeName, total]) => ({ storeName, total }))
      .sort((a, b) => a.total - b.total);

    return { items, totals, stores };
  },

  /** Resolve a list (non-coalesced). */
  async resolveList(list, options = {}) {
    const out = [];
    for (const it of list || []) {
      try {
        out.push(await this.resolve(it, options));
      } catch (e) {
        logger.warn?.("[ingredientResolver] failed", it, e);
      }
    }
    return out;
  },

  /** Favorite alias registration helpers. */
  addFavoriteAlias(alias, canonicalKey) {
    if (!alias || !canonicalKey) return false;
    FAVORITE_ALIASES[toKey(alias)] = canonicalKey;
    try {
      usdaDefaults?.addAlias?.(alias, canonicalKey);
    } catch {}
    return true;
  },
  addFavoriteAliases(pairs = []) {
    for (const p of pairs) this.addFavoriteAlias(p.alias, p.key);
    return true;
  },

  /** Tiny helpers */
  parseLine,
  slugify,
  guessDensity: (name) => guessDensity(name),
  isPassover: (ing) => isPassover(ing),
};

export default ingredientResolver;

/* ----------------------------------------------------------------------------
   Defaults & listeners
---------------------------------------------------------------------------- */
function getDefaultVendors() {
  return [
    {
      id: DEFAULT_STORE,
      name: DEFAULT_STORE,
      priority: 9,
      aisles: [
        { name: "Produce", match: [/onion|okra|greens|spinach|tomato/i] },
        {
          name: "Grains/Pasta",
          match: [
            /rice|quinoa|oat|grit|mac(?!hine)|pasta|fufu|garri|eba|millet/i,
          ],
        },
        {
          name: "Meat/Seafood",
          match: [/chicken|beef|lamb|goat|fish|catfish|turkey/i],
        },
        { name: "Dairy", match: [/yogurt|milk|cheese|butter/i] },
        { name: "Oils/Spices", match: [/oil|suya|spice|sauce|gravy/i] },
        { name: "Canned Goods", match: [/canned|crushed tomato|beans|peas/i] },
        { name: DEFAULT_AISLE, match: [] },
      ].map((a) => ({ name: a.name, matchers: a.match })),
    },
  ];
}

// Reactive: cuisine packs changed → clear caches; favorites changed handled above.
// Also prime/refresh cuisine bias when the household profile updates.
try {
  eventBus?.on?.("cuisine.packs.changed", () => {
    LRU.clear?.();
    rebuildFavoriteAliases();
    primeCuisineBiasFromPrefs();
    logger.info?.(
      "[ingredientResolver] cuisine packs changed → cache cleared & cuisine bias primed"
    );
  });

  eventBus?.on?.("household.profile.updated", ({ profile } = {}) => {
    try {
      if (setCuisineBiasFn) {
        const tags = (profile?.cuisineBias || [])
          .map((b) => b.tag || b)
          .filter(Boolean);
        setCuisineBiasFn(tags.length ? tags : ["african-american"]);
      }
      LRU.clear?.();
      logger.info?.(
        "[ingredientResolver] household.profile.updated → cuisine bias updated & cache cleared"
      );
    } catch (e) {
      logger.warn?.("[ingredientResolver] profile update handling failed", e);
    }
  });

  eventBus?.on?.("favorites.updated", () => rebuildFavoriteAliases());
} catch {}

/* ----------------------------------------------------------------------------
   util: safe getter
---------------------------------------------------------------------------- */
function getIn(obj, path) {
  if (!obj || !path) return undefined;
  const parts = path.split(".");
  let cur = obj;
  for (const p of parts) {
    cur = cur?.[p];
    if (cur == null) return undefined;
  }
  return cur;
}
