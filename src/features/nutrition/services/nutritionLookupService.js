// src/features/nutrition/services/nutritionLookupService.js

/**
 * Nutrition Lookup Service
 * -----------------------------------------------------------------------------
 * Goals:
 *  - Multi-source nutrition search & fetch
 *      1) Custom foods from store (user-defined)
 *      2) Local mini DB (common foods; extendable)
 *      3) Optional backend adapters (e.g., USDA FDC via /api/nutrition/fdc/*)
 *  - Parse ingredient lines -> {name, qty, unit, grams} + nutrition
 *  - Intuitive UX via events: resolves inventory items & recipes automatically
 *  - Torah-aware flags, Keto/Satiety scores, hair-growth nudges
 *  - Lightweight caching (localStorage) with TTL
 *  - No hard dependency on any one store or backend (safe dynamic imports)
 *
 * Events listened:
 *  - "suka:inventoryUpsert" { items }     -> auto-enrich missing nutrition
 *  - "suka:recipesImported" { recipes }   -> try to enrich recipe ingredients
 *
 * Events emitted:
 *  - "suka:nutritionResolved" { items|recipeId|lines }
 *  - "suka:nutritionError"    { error, context }
 */

const CACHE_KEY = "nutritionLookup:v1";
const CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days

/* ------------------------------ Mini Local DB ------------------------------ */
/** Extend as needed; values per 100 g to simplify scaling. */
const LOCAL_DB = [
  // meats
  fdb("ground-beef-80-20", "Ground Beef (80/20), raw", 100, { kcal: 254, protein: 17.0, fat: 20.0, carbs: 0.0 }),
  fdb("lamb-leg-raw", "Lamb (leg), raw", 100, { kcal: 206, protein: 20.0, fat: 14.0, carbs: 0.0 }),
  fdb("goat-raw", "Goat, raw", 100, { kcal: 143, protein: 27.1, fat: 3.0, carbs: 0.0 }),
  fdb("chicken-breast-raw", "Chicken Breast, raw", 100, { kcal: 120, protein: 22.5, fat: 2.6, carbs: 0.0 }),
  // staples
  fdb("millet-dry", "Millet (dry)", 100, { kcal: 378, protein: 11.0, fat: 4.2, carbs: 73.0, fiber: 8.5 }),
  fdb("oats-dry", "Oats (dry)", 100, { kcal: 389, protein: 16.9, fat: 6.9, carbs: 66.3, fiber: 10.6 }),
  fdb("olive-oil", "Olive Oil", 100, { kcal: 884, protein: 0.0, fat: 100.0, carbs: 0.0 }),
  fdb("egg-large", "Egg, whole (large ~50 g)", 50, { kcal: 72, protein: 6.3, fat: 4.8, carbs: 0.4 }),
  // greens / seeds
  fdb("spinach-raw", "Spinach, raw", 100, { kcal: 23, protein: 2.9, fat: 0.4, carbs: 3.6, fiber: 2.2, iron_mg: 2.7 }),
  fdb("pumpkin-seeds", "Pumpkin seeds (pepitas)", 100, { kcal: 559, protein: 30.2, fat: 49.1, carbs: 10.7, fiber: 6.0, zinc_mg: 7.6, magnesium_mg: 592 }),
  // fish
  fdb("salmon-raw", "Salmon, raw", 100, { kcal: 208, protein: 20.4, fat: 13.4, carbs: 0.0, omega3_g: 2.6 }),
];

function fdb(id, name, baseGram, perBase) {
  return { id, name, baseGram, perBase }; // nutrition numbers are per baseGram weight
}

/* ------------------------------- Unit Parsing ------------------------------ */

const UNIT_ALIASES = {
  g: ["g", "gram", "grams"],
  kg: ["kg", "kilogram", "kilograms"],
  mg: ["mg", "milligram", "milligrams"],
  lb: ["lb", "lbs", "pound", "pounds"],
  oz: ["oz", "ounce", "ounces"],
  tbsp: ["tbsp", "tablespoon", "tablespoons"],
  tsp: ["tsp", "teaspoon", "teaspoons"],
  cup: ["cup", "cups"],
  piece: ["piece", "pieces", "pc", "pcs"],
};

const UNIT_TO_G = {
  g: 1,
  kg: 1000,
  mg: 0.001,
  lb: 453.592,
  oz: 28.3495,
  tbsp: 14, // rough defaults for "misc foods" when density unknown
  tsp: 5,
  cup: 240,
  piece: 50, // fallback; many foods override via shape rules
};

function canonicalUnit(u) {
  if (!u) return null;
  const s = String(u).trim().toLowerCase();
  for (const [canon, arr] of Object.entries(UNIT_ALIASES)) {
    if (arr.includes(s)) return canon;
  }
  return null;
}

/** Rough special-case density table by ingredient hints (improves estimateFromLine) */
const DENSITY_HINTS = [
  { match: /(olive\s*oil|oil)/i, unitG: { tbsp: 13.5, tsp: 4.5, cup: 216 } },
  { match: /(water|broth|stock|milk)/i, unitG: { tbsp: 15, tsp: 5, cup: 240 } },
  { match: /(flour|millet|oat)/i, unitG: { tbsp: 8, tsp: 2.6, cup: 120 } },
  { match: /(sugar|salt)/i, unitG: { tbsp: 12.5, tsp: 4.2, cup: 200 } },
  { match: /(pumpkin\s*seeds|pepitas|seeds)/i, unitG: { tbsp: 9, cup: 129 } },
  { match: /(spinach)/i, unitG: { cup: 30 } },
  { match: /(egg)/i, unitG: { piece: 50 } },
  { match: /(beef|lamb|goat|chicken|salmon)/i, unitG: { oz: 28.3495, lb: 453.592 } },
];

function unitToGrams(name, qty, unit) {
  const c = canonicalUnit(unit);
  if (!c || !qty) return null;

  // Try density hints first
  for (const hint of DENSITY_HINTS) {
    if (hint.match.test(name)) {
      const uMap = hint.unitG || {};
      if (uMap[c]) return qty * uMap[c];
    }
  }

  // Fallback generic conversion
  if (UNIT_TO_G[c]) return qty * UNIT_TO_G[c];
  return null;
}

/* --------------------------- Parse Ingredient Line ------------------------- */
/** "2 tbsp olive oil" | "1 cup cooked millet" | "3 eggs" | "8 oz lamb" */
export function parseIngredientLine(line) {
  const s = String(line || "").trim();
  if (!s) return { name: "", qty: 1, unit: "", grams: 0 };

  // capture mixed fractions like 1 1/2
  const frac = /(\d+)\s+(\d+)\/(\d+)/;
  const mfrac = s.match(frac);
  let qty = 1;
  let rest = s;

  if (mfrac) {
    const base = Number(mfrac[1] || 0);
    const num = Number(mfrac[2] || 0);
    const den = Number(mfrac[3] || 1);
    qty = base + num / den;
    rest = s.replace(frac, "").trim();
  } else {
    const mnum = s.match(/^(\d+(\.\d+)?)\s+(.*)$/);
    if (mnum) {
      qty = Number(mnum[1]);
      rest = mnum[3];
    }
  }

  const parts = rest.split(/\s+/);
  let unit = "";
  let name = rest;

  if (parts.length > 1) {
    const maybeUnit = canonicalUnit(parts[0]);
    if (maybeUnit) {
      unit = maybeUnit;
      name = parts.slice(1).join(" ");
    } else {
      // trailing "eggs" as unit -> piece
      if (/^eggs?$/i.test(parts[0])) {
        unit = "piece";
        name = parts.slice(1).join(" ");
      }
    }
  }

  // fallback: "3 eggs" → qty=3, unit=piece
  if (!unit && /\beggs?\b/i.test(rest)) {
    unit = "piece";
    name = rest.replace(/\beggs?\b/i, "").trim() || "egg";
  }

  const grams = unitToGrams(name, qty, unit) ?? 0;
  return { name: name.trim(), qty, unit, grams };
}

/* --------------------------------- Helpers -------------------------------- */

const round1 = (n) => Math.round((Number(n) || 0) * 10) / 10;
const round0 = (n) => Math.round(Number(n) || 0);

function per100gToForGrams(perBase, baseGram, grams) {
  // Our LOCAL_DB entries are per baseGram (often 100 g)
  const k = grams / (baseGram || 100);
  const out = {};
  for (const [key, val] of Object.entries(perBase || {})) {
    out[key] = (Number(val) || 0) * k;
  }
  return out;
}

function torahFlagsByName(name = "") {
  const s = String(name).toLowerCase();
  const banned = /(pork|bacon|ham|prosciutto|shrimp|lobster|crab|oyster|clam|mussel|scallop|catfish)/i.test(s);
  return { torahAllowed: !banned };
}

function ketoScore(n) {
  // higher protein+fat, lower net carbs -> higher score
  const protein = Number(n.protein || 0);
  const fat = Number(n.fat || 0);
  const carbs = Number(n.carbs || 0);
  const fiber = Number(n.fiber || 0);
  const net = Math.max(0, carbs - fiber);
  const kcal = Number(n.kcal || protein * 4 + fat * 9 + carbs * 4);
  const density = kcal > 0 ? (protein * 4 + fat * 9) / kcal : 0;
  // scale 0..1, penalize net carb density
  const pen = Math.min(1, net / 30);
  return round1(Math.max(0, density * (1 - pen)));
}

function satietyScore(n) {
  // simple satiety proxy: (protein + fiber*0.5) per 100 kcal
  const protein = Number(n.protein || 0);
  const fiber = Number(n.fiber || 0);
  const kcal = Number(n.kcal || protein * 4 + (n.fat || 0) * 9 + (n.carbs || 0) * 4) || 1;
  return round1(((protein + 0.5 * fiber) / kcal) * 100);
}

/* --------------------------------- Caching -------------------------------- */

function now() {
  return Date.now();
}

function loadCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? JSON.parse(raw) : { byId: {}, byKey: {}, t: 0 };
  } catch {
    return { byId: {}, byKey: {}, t: 0 };
  }
}

function saveCache(cache) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
  } catch {}
}

function cacheGet(key) {
  const c = loadCache();
  if (now() - (c.t || 0) > CACHE_TTL_MS) return null;
  return c.byKey?.[key] || null;
}

function cacheSet(key, val) {
  const c = loadCache();
  c.byKey = c.byKey || {};
  c.byKey[key] = val;
  c.t = now();
  saveCache(c);
}

function cacheGetId(id) {
  const c = loadCache();
  if (now() - (c.t || 0) > CACHE_TTL_MS) return null;
  return c.byId?.[id] || null;
}

function cacheSetId(id, val) {
  const c = loadCache();
  c.byId = c.byId || {};
  c.byId[id] = val;
  c.t = now();
  saveCache(c);
}

/* ------------------------------ Source Adapters ---------------------------- */

async function getCustomFoodsFromStore() {
  try {
    const mod = await import("@/store/CustomFoodStore");
    const useStore = mod.default || mod.useCustomFoodStore || null;
    const st = typeof useStore === "function" ? (useStore.getState ? useStore.getState() : useStore()) : null;
    return st?.foods || [];
  } catch {
    return [];
  }
}

async function addCustomFoodToStore(food) {
  try {
    const mod = await import("@/store/CustomFoodStore");
    const useStore = mod.default || mod.useCustomFoodStore || null;
    if (typeof useStore === "function") {
      const api = useStore.getState ? useStore.getState() : useStore();
      if (typeof api?.addFood === "function") api.addFood(food);
    }
  } catch {
    // ignore
  }
}

/** Search local DB by name substring */
function localSearch(query) {
  const q = String(query).toLowerCase();
  return LOCAL_DB.filter((row) => row.name.toLowerCase().includes(q)).map((row) => ({
    id: `local:${row.id}`,
    name: row.name,
    baseGram: row.baseGram,
    perBase: row.perBase,
    source: "local",
  }));
}

function localGet(id) {
  const key = id.replace(/^local:/, "");
  const row = LOCAL_DB.find((r) => r.id === key);
  return row
    ? { id: `local:${row.id}`, name: row.name, baseGram: row.baseGram, perBase: row.perBase, source: "local" }
    : null;
}

/** Optional USDA FDC backend adapter (proxy endpoints you control) */
async function fdcSearch(query) {
  try {
    const res = await fetch(`/api/nutrition/fdc/search?q=${encodeURIComponent(query)}`);
    if (!res.ok) return [];
    const data = await res.json();
    // Expect [{fdcId, description, nutrients:{...} per 100g?}] – adjust to your backend shape
    return (data || []).map((it) => ({
      id: `fdc:${it.fdcId}`,
      name: it.description,
      baseGram: 100,
      perBase: it.nutrients || {},
      source: "fdc",
    }));
  } catch {
    return [];
  }
}

async function fdcGet(id) {
  try {
    const fdcId = id.replace(/^fdc:/, "");
    const res = await fetch(`/api/nutrition/fdc/food/${fdcId}`);
    if (!res.ok) return null;
    const it = await res.json();
    return it
      ? {
          id: `fdc:${it.fdcId}`,
          name: it.description,
          baseGram: 100,
          perBase: it.nutrients || {},
          source: "fdc",
        }
      : null;
  } catch {
    return null;
  }
}

/* ------------------------------- Public API -------------------------------- */

/**
 * searchFoods(query, { sources })
 * sources: array subset of ["store","local","fdc"]
 */
export async function searchFoods(query, opts = {}) {
  const key = `search:${(opts.sources || []).join(",")}:${query}`;
  const hit = cacheGet(key);
  if (hit) return hit;

  const sources = opts.sources || ["store", "local", "fdc"];
  let out = [];

  if (sources.includes("store")) {
    const custom = await getCustomFoodsFromStore();
    const q = String(query).toLowerCase();
    out = out.concat(
      custom
        .filter((f) => (f.name || "").toLowerCase().includes(q))
        .map((f) => ({ ...f, id: f.id || `store:${hashId(f.name)}`, source: "store" }))
    );
  }

  if (sources.includes("local")) {
    out = out.concat(localSearch(query));
  }

  if (sources.includes("fdc")) {
    out = out.concat(await fdcSearch(query));
  }

  // de-dup by (name,source)
  const dedup = new Map();
  for (const it of out) {
    dedup.set(`${it.source}:${(it.name || "").toLowerCase()}`, it);
  }
  const result = [...dedup.values()];
  cacheSet(key, result);
  return result;
}

/**
 * getFoodById(id)
 * Returns normalized { id, name, per100g, meta }
 */
export async function getFoodById(id) {
  const hit = cacheGetId(id);
  if (hit) return hit;

  let row = null;
  if (id.startsWith("local:")) row = localGet(id);
  else if (id.startsWith("fdc:")) row = await fdcGet(id);
  else if (id.startsWith("store:")) {
    const foods = await getCustomFoodsFromStore();
    row = foods.find((f) => (f.id || "").toLowerCase() === id.toLowerCase()) || null;
    if (row && !row.perBase && row.per100g) {
      row = { ...row, baseGram: 100, perBase: row.per100g };
    }
    row = row ? { ...row, source: "store" } : null;
  }

  // if row still null, try interpret as local name key
  if (!row) {
    const m = id.match(/^(.+?):(.+)/);
    if (!m) {
      // attempt local search by id-as-name
      const local = localSearch(id);
      row = local[0] || null;
    }
  }

  if (!row) return null;

  const per100g = row.baseGram ? per100gify(row.perBase, row.baseGram) : (row.per100g || row.perBase || {});
  const out = { id: row.id, name: row.name, source: row.source, per100g, meta: {} };
  cacheSetId(id, out);
  return out;
}

function per100gify(perBase, baseGram) {
  const k = 100 / (baseGram || 100);
  const out = {};
  for (const [key, val] of Object.entries(perBase || {})) {
    out[key] = (Number(val) || 0) * k;
  }
  return out;
}

/**
 * estimateNutritionForLine("2 tbsp olive oil")
 *  - parses the line, finds best-matching food, returns nutrition for specified grams
 */
export async function estimateNutritionForLine(line, opts = {}) {
  const parsed = parseIngredientLine(line);
  const q = parsed.name || line;
  const candidates = await searchFoods(q, opts);
  const best = rankByNameSimilarity(q, candidates)[0] || null;

  // If none found, return estimated shell with grams only
  if (!best) {
    return {
      line,
      parsed,
      nutrition: { kcal: 0, protein: 0, fat: 0, carbs: 0, fiber: 0 },
      grams: parsed.grams,
      source: "estimate",
      flags: torahFlagsByName(parsed.name),
      scores: { keto: 0, satiety: 0 },
    };
  }

  const base = best.perBase
    ? per100gify(best.perBase, best.baseGram || 100)
    : (await getFoodById(best.id))?.per100g || {};

  // Use parsed grams; if 0, fallback 1 serving heuristics by source/item
  const grams = parsed.grams > 0 ? parsed.grams : fallbackServingGrams(best.name);
  const n = scalePer100g(base, grams);

  return {
    line,
    parsed,
    item: { id: best.id, name: best.name, source: best.source },
    grams,
    nutrition: n,
    flags: torahFlagsByName(best.name),
    scores: { keto: ketoScore(n), satiety: satietyScore(n) },
  };
}

function scalePer100g(per100g, grams) {
  const k = grams / 100;
  const out = {};
  for (const [key, val] of Object.entries(per100g || {})) {
    out[key] = round1((Number(val) || 0) * k);
  }
  // Ensure kcal presence
  out.kcal =
    out.kcal ||
    round1((Number(out.protein || 0) * 4 + Number(out.fat || 0) * 9 + Number(out.carbs || 0) * 4));
  return out;
}

function fallbackServingGrams(name = "") {
  const s = name.toLowerCase();
  if (s.includes("egg")) return 50;
  if (s.includes("oil")) return 14; // 1 tbsp
  if (s.includes("spinach")) return 30; // 1 cup raw
  if (s.includes("millet") || s.includes("oat")) return 40; // dry serving
  if (s.includes("beef") || s.includes("lamb") || s.includes("goat") || s.includes("chicken") || s.includes("salmon"))
    return 113; // 4 oz
  return 100;
}

function rankByNameSimilarity(query, items) {
  const q = String(query).toLowerCase();
  return [...items]
    .map((it) => {
      const n = (it.name || "").toLowerCase();
      let score = 0;
      if (n === q) score = 1.0;
      else if (n.includes(q)) score = 0.85;
      else score = jaccard(q, n);
      return { it, score };
    })
    .sort((a, b) => b.score - a.score)
    .map((x) => ({ ...x.it, _score: x.score }));
}

function jaccard(a, b) {
  const setA = new Set(a.split(/\s+/));
  const setB = new Set(b.split(/\s+/));
  const inter = [...setA].filter((x) => setB.has(x)).length;
  const uni = new Set([...setA, ...setB]).size || 1;
  return inter / uni;
}

/**
 * enrichInventoryItems(items[])
 *  - returns new array with {nutrition, gramsDefault, flags, scores}
 */
export async function enrichInventoryItems(items = []) {
  const out = [];
  for (const it of items) {
    const name = it.name || "";
    const qty = Number(it.qty || 1);
    const unit = it.unit || "";
    const grams = unitToGrams(name, qty, unit) ?? fallbackServingGrams(name);
    const candidates = await searchFoods(name, {});
    const best = rankByNameSimilarity(name, candidates)[0] || null;
    let nutrition = { kcal: 0, protein: 0, fat: 0, carbs: 0, fiber: 0 };

    if (best) {
      const base = best.perBase
        ? per100gify(best.perBase, best.baseGram || 100)
        : (await getFoodById(best.id))?.per100g || {};
      nutrition = scalePer100g(base, grams);
    }

    out.push({
      ...it,
      gramsDefault: grams,
      nutrition,
      flags: torahFlagsByName(name),
      scores: { keto: ketoScore(nutrition), satiety: satietyScore(nutrition) },
    });
  }
  return out;
}

/**
 * computeRecipeNutrition(recipe)
 * - Sums nutrition of each ingredient line
 */
export async function computeRecipeNutrition(recipe) {
  const lines = (recipe?.ingredients || []).filter(Boolean);
  const resolved = [];
  let sum = { kcal: 0, protein: 0, fat: 0, carbs: 0, fiber: 0 };

  for (const line of lines) {
    const r = await estimateNutritionForLine(line);
    resolved.push(r);
    sum.kcal += r.nutrition.kcal || 0;
    sum.protein += r.nutrition.protein || 0;
    sum.fat += r.nutrition.fat || 0;
    sum.carbs += r.nutrition.carbs || 0;
    sum.fiber += r.nutrition.fiber || 0;
  }

  // Round outputs
  for (const k of Object.keys(sum)) sum[k] = round1(sum[k]);

  const flags = torahFlagsByName(recipe?.title || "");
  const scores = { keto: ketoScore(sum), satiety: satietyScore(sum) };

  return { lines: resolved, totals: sum, flags, scores };
}

/**
 * addCustomFood({ id?, name, per100g, tags? })
 */
export async function addCustomFood(food) {
  const id = food.id || `store:${hashId(food.name)}`;
  const entry = { ...food, id, source: "store" };
  await addCustomFoodToStore(entry);
  // prime cache
  cacheSetId(id, { id, name: entry.name, source: "store", per100g: entry.per100g, meta: {} });
  return entry;
}

/* -------------------------- Event-Oriented Bootstrap ----------------------- */

export function initNutritionLookup() {
  const onInventoryUpsert = async (e) => {
    try {
      const items = e?.detail?.items || [];
      const enriched = await enrichInventoryItems(items);
      dispatch("suka:nutritionResolved", { type: "inventory", items: enriched });
    } catch (err) {
      dispatch("suka:nutritionError", { error: err?.message || String(err), context: "inventoryUpsert" });
    }
  };

  const onRecipesImported = async (e) => {
    try {
      const recipes = e?.detail?.recipes || [];
      for (const r of recipes) {
        const nu = await computeRecipeNutrition(r);
        dispatch("suka:nutritionResolved", { type: "recipe", recipeId: r.id, nutrition: nu });
      }
    } catch (err) {
      dispatch("suka:nutritionError", { error: err?.message || String(err), context: "recipesImported" });
    }
  };

  window.addEventListener("suka:inventoryUpsert", onInventoryUpsert);
  window.addEventListener("suka:recipesImported", onRecipesImported);

  return () => {
    window.removeEventListener("suka:inventoryUpsert", onInventoryUpsert);
    window.removeEventListener("suka:recipesImported", onRecipesImported);
  };
}

/* -------------------------------- Utilities -------------------------------- */

function hashId(s) {
  let h = 0;
  const str = String(s || "");
  for (let i = 0; i < str.length; i++) {
    h = (h << 5) - h + str.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h).toString(36);
}

function dispatch(name, detail) {
  try {
    window.dispatchEvent(new CustomEvent(name, { detail }));
  } catch {}
}

/* ------------------------------ Developer Notes ---------------------------- *
 * - The FDC adapter assumes you have a backend proxy with:
 *    GET /api/nutrition/fdc/search?q=...
 *    GET /api/nutrition/fdc/food/:fdcId
 *   returning normalized nutrient maps per 100 g.
 *
 * - You can add other adapters (e.g., Edamam) by following the same shape
 *   (id prefix, perBase/per100g normalization).
 *
 * - Inventory/Recipe modules can listen for "suka:nutritionResolved" to
 *   store final nutrition details into their state and display visible drafts.
 *
 * - Torah awareness is string-based here; for stricter rules, connect to your
 *   central rules engine and replace torahFlagsByName().
 * 
 * 
 *  
 */