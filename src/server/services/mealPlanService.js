// C:\Users\larho\suka-smart-assistant\src\server\services\mealPlanService.js
//
// Suka Smart Assistant — Meal Plan Service (Dynamic)
//
// Purpose:
//   Generate/edit weekly plans that balance: pantry-first usage, macros/diet,
//   budget hints, cooking time vs. busy days, garden season, and household
//   preferences. Returns "visible drafts" for UI preview/edit before saving.
//
// Key Features aligned with project chats:
//   • Pantry-first planner (uses inventory snapshot; subtracts what you have)
//   • Macros-aware scoring (hooks to nutritionLookupService when available)
//   • Sabbath-aware: avoids new cooking tasks on Day 7; chooses no-cook / reheats
//   • Batch-cook linking + leftovers roll-forward
//   • Grocery list (groups by aisle; delta vs inventory via cookingService/inventoryService)
//   • Calendar export (hebrew skip); label drafts for batch sessions if needed
//   • Budget estimate (simple price heuristics + inventory price meta)
//   • n8n-friendly compact payloads
//
// Storage: Local JSON (dev/offline) under data/meal-plans.json.
// Lazy bridges to: cookingService, inventoryService, nutritionLookupService, calendarService.
//
// ------------------------------------------------------------------------------

import fs from "fs/promises";
import path from "path";
import crypto from "crypto";

// ---- Lazy bridges ------------------------------------------------------------
let cookingService = null;
let inventoryService = null;
let nutritionLookupService = null;
let calendarService = null;
let catalogSyncService = null;
let sharedAllergenMap = null;

async function getCookingService() {
  if (!cookingService) {
    const mod = await import("./cookingService.js").catch(() => null);
    cookingService = mod ? (mod.default || mod) : null;
  }
  return cookingService;
}
async function getInventoryService() {
  if (!inventoryService) {
    const mod = await import("./inventoryService.js").catch(() => null);
    inventoryService = mod ? (mod.default || mod) : null;
  }
  return inventoryService;
}
async function getNutritionService() {
  if (!nutritionLookupService) {
    const mod = await import("../../features/nutrition/services/nutritionLookupService.js").catch(() => null);
    nutritionLookupService = mod ? (mod.default || mod) : null;
  }
  return nutritionLookupService;
}
async function getCalendarService() {
  if (!calendarService) {
    const mod = await import("./calendarService.js").catch(() => null);
    calendarService = mod ? (mod.default || mod) : null;
  }
  return calendarService;
}

async function getCatalogSyncService() {
  if (!catalogSyncService) {
    const mod = await import("./catalogSyncService.js").catch(() => null);
    catalogSyncService = mod
      ? mod.default || mod
      : null;
  }
  return catalogSyncService;
}

async function getSharedAllergenMap() {
  if (sharedAllergenMap) return sharedAllergenMap;
  try {
    const file = path.resolve(
      process.cwd(),
      "src/catalogs/cuisines_shared/allergens.map.json",
    );
    const raw = await fs.readFile(file, "utf-8");
    const parsed = JSON.parse(raw || "{}");
    sharedAllergenMap = {
      termMap: parsed?.termMap || {},
      ingredientTriggers: Array.isArray(parsed?.ingredientTriggers)
        ? parsed.ingredientTriggers
        : [],
    };
  } catch {
    sharedAllergenMap = { termMap: {}, ingredientTriggers: [] };
  }
  return sharedAllergenMap;
}

// ---- Local JSON store --------------------------------------------------------
const DATA_DIR = path.resolve(process.cwd(), "data");
const FILE = path.join(DATA_DIR, "meal-plans.json");

async function ensureStore() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try { await fs.access(FILE); }
  catch { await fs.writeFile(FILE, JSON.stringify([], null, 2), "utf-8"); }
}
async function readJson() {
  await ensureStore();
  const raw = await fs.readFile(FILE, "utf-8");
  return JSON.parse(raw || "[]");
}
async function writeJson(data) {
  await ensureStore();
  await fs.writeFile(FILE, JSON.stringify(data, null, 2), "utf-8");
}

// ---- Utilities ---------------------------------------------------------------
const uid = () => crypto.randomUUID();
const nowISO = () => new Date().toISOString();
const ISODate = (d) => new Date(d).toISOString().slice(0, 10);
const coalesce = (a, b) => (typeof a === "undefined" ? b : a);

function addDays(iso, days) {
  const d = new Date(iso);
  d.setDate(d.getDate() + days);
  return ISODate(d);
}
function dayOfWeek(iso) {
  // 0=Sun ... 6=Sat
  return new Date(iso).getUTCDay();
}
function isHebrewSabbath(iso, { skipSabbath = true, sabbathIsSaturday = false } = {}) {
  if (!skipSabbath) return false;
  const dow = dayOfWeek(iso);
  // Placeholder: treat Saturday as Sabbath by default; adjust when Hebrew core is wired
  return sabbathIsSaturday ? dow === 6 : dow === 6;
}

function normalizeUnit(u) {
  if (!u) return "unit";
  const s = String(u).toLowerCase();
  if (["g", "gram", "grams"].includes(s)) return "g";
  if (["kg", "kilogram", "kilograms"].includes(s)) return "kg";
  if (["lb", "lbs", "pound", "pounds"].includes(s)) return "lb";
  if (["oz", "ounce", "ounces"].includes(s)) return "oz";
  if (["ml"].includes(s)) return "ml";
  if (["l", "liter", "litre"].includes(s)) return "l";
  if (["tsp", "teaspoon", "teaspoons"].includes(s)) return "tsp";
  if (["tbsp", "tablespoon", "tablespoons"].includes(s)) return "tbsp";
  if (["cup", "cups"].includes(s)) return "cup";
  if (["ct", "unit", "piece", "pcs"].includes(s)) return "ct";
  return s;
}

function roughPriceUSD(ing) {
  // Heuristic fallback; overridden if inventory meta has a known price
  const n = (ing.name || "").toLowerCase();
  const qty = Number(ing.qty) || 0;
  const unit = normalizeUnit(ing.unit);
  if (/beef|lamb|goat|steak|chicken|turkey/.test(n)) return (unit === "lb" ? qty : qty / 453.6) * 6.0;
  if (/fish|shrimp|salmon|tuna/.test(n)) return (unit === "lb" ? qty : qty / 453.6) * 8.0;
  if (/cheese|milk|yogurt|cream/.test(n)) return (unit === "lb" ? qty : qty / 453.6) * 4.0;
  if (/egg/.test(n)) return (unit === "ct" ? qty : qty / 50) * 0.30;
  if (/rice|flour|beans|lentil|oat|pasta/.test(n)) return 0.005 * (unit === "g" ? qty : unit === "kg" ? qty * 1000 : 500);
  if (/tomato|pepper|onion|greens|lettuce|kale|apple|banana|carrot|broccoli/.test(n)) return 0.003 * (unit === "g" ? qty : unit === "kg" ? qty * 1000 : 300);
  return 0.002 * (unit === "g" ? qty : 250);
}

function extractCatalogMeta(recipe = {}) {
  const tags = asArray(recipe.tags).map((t) => String(t || "").toLowerCase());
  const domainTag = tags.find((t) => t.startsWith("catalog:")) || null;
  const domainFromTag = domainTag
    ? domainTag.replace(/^catalog:/, "").split(":")[0]
    : null;

  return {
    isCatalog:
      String(recipe.origin || "").toLowerCase() === "catalog" ||
      String(recipe.source || "").toLowerCase() === "catalog" ||
      String(recipe.source || "").toLowerCase() === "cataloglibrary" ||
      Boolean(recipe.catalogDomain) ||
      Boolean(recipe.meta?.catalog?.catalogDomain),
    catalogDomain:
      recipe.catalogDomain ||
      recipe.meta?.catalog?.catalogDomain ||
      domainFromTag ||
      null,
    catalogId:
      recipe.catalogId ||
      recipe.meta?.catalog?.catalogId ||
      recipe.meta?.id ||
      recipe.id ||
      null,
    tags,
  };
}

function normalizeText(v) {
  return String(v || "")
    .toLowerCase()
    .trim()
    .replace(/[\u2019']/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenizeRecipeText(recipe = {}) {
  const tokens = [];
  for (const t of asArray(recipe.tags)) tokens.push(String(t || ""));
  for (const a of asArray(recipe.allergens)) tokens.push(String(a || ""));
  for (const ing of asArray(recipe.ingredients)) {
    tokens.push(String(ing?.name || ""));
    tokens.push(String(ing?.label || ""));
  }
  return tokens.map(normalizeText).filter(Boolean);
}

async function inferRecipeAllergenIds(recipe = {}) {
  const out = new Set();
  const tags = asArray(recipe.tags).map((x) => String(x || "").toLowerCase());
  for (const t of tags) {
    if (t.startsWith("allergen:")) out.add(t.replace(/^allergen:/, "").trim());
  }

  const dict = await getSharedAllergenMap();
  const termMap = dict?.termMap || {};
  const triggers = Array.isArray(dict?.ingredientTriggers)
    ? dict.ingredientTriggers
    : [];

  const recipeText = tokenizeRecipeText(recipe);
  const joined = ` ${recipeText.join(" ")} `;

  for (const [term, ids] of Object.entries(termMap)) {
    const key = normalizeText(term);
    if (!key) continue;
    if (joined.includes(` ${key} `) || joined.includes(key)) {
      for (const id of asArray(ids)) out.add(String(id));
    }
  }

  for (const trig of triggers) {
    const aid = String(trig?.allergenId || "").trim();
    if (!aid) continue;
    const toks = asArray(trig?.tokens).map(normalizeText).filter(Boolean);
    if (!toks.length) continue;
    if (toks.some((tok) => joined.includes(` ${tok} `) || joined.includes(tok))) {
      out.add(aid);
    }
  }

  return out;
}

async function getCatalogRuleSignals() {
  const service = await getCatalogSyncService();
  const snap = service?.getCatalogRuleIndexSnapshot
    ? await service.getCatalogRuleIndexSnapshot()
    : { rules: [] };

  const rules = Array.isArray(snap?.rules) ? snap.rules : [];
  const recipeSourceDomains = new Set([
    "bakery",
    "breads",
    "desserts",
    "soups",
    "shawarma",
    "pastes",
    "cuisines",
  ]);
  const ruleSourceDomains = new Set();

  for (const r of rules) {
    const domain = String(r?.domain || "").toLowerCase().trim();
    if (!domain) continue;
    if (recipeSourceDomains.has(domain)) continue;
    ruleSourceDomains.add(domain);
  }

  return {
    recipeSourceDomains,
    ruleSourceDomains,
    hasEstimatorRules:
      ruleSourceDomains.has("estimators") ||
      rules.some((r) => String(r?.type || "").toLowerCase().includes("estimator")),
    hasSeasonalityRules:
      ruleSourceDomains.has("farm-to-table") ||
      ruleSourceDomains.has("homestead"),
    hasCuisineRules:
      ruleSourceDomains.has("cuisines") ||
      rules.some((r) => String(r?.subdomain || "").toLowerCase().length > 0),
  };
}

function asArray(v) {
  return Array.isArray(v) ? v : v ? [v] : [];
}

// ---- Nutrition summary -------------------------------------------------------
async function computeRecipeNutrition(recipe) {
  const ns = await getNutritionService();
  if (ns?.lookupIngredients) {
    return ns.lookupIngredients(recipe.ingredients || [], { preferUS: true, fallbackSimpleHeuristics: true });
  }
  // Fallback: sum via simple heuristics similar to cookingService
  const per100g = { kcal: 200, protein: 12, fat: 10, carbs: 8 };
  let gramsTotal = 0;
  for (const ing of recipe.ingredients || []) {
    const qty = Number(ing.qty) || 0;
    const unit = normalizeUnit(ing.unit);
    const toG =
      unit === "g" ? qty :
      unit === "kg" ? qty * 1000 :
      unit === "lb" ? qty * 453.6 :
      unit === "oz" ? qty * 28.35 :
      unit === "ml" ? qty :
      unit === "cup" ? qty * 240 :
      unit === "tbsp" ? qty * 15 :
      unit === "tsp" ? qty * 5 :
      qty * 50;
    gramsTotal += toG;
  }
  const f = gramsTotal / 100;
  return { kcal: Math.round(per100g.kcal * f), protein: Math.round(per100g.protein * f), fat: Math.round(per100g.fat * f), carbs: Math.round(per100g.carbs * f) };
}

async function recipeWithNutrition(recipe) {
  if (recipe.nutrition) return recipe;
  const nutrition = await computeRecipeNutrition(recipe);
  return { ...recipe, nutrition };
}

// ---- Core: generation & persistence -----------------------------------------

/**
 * generatePlan — visible draft
 * Inputs may include household prefs, busy-day hints, macros targets, themes.
 */
export async function generatePlan(input = {}) {
  const {
    title = "Weekly Meal Plan",
    startDate = new Date().toISOString().slice(0, 10),
    days = 7,
    people = 4,
    mealsPerDay = ["Dinner"], // can include Breakfast/Lunch/Snack
    diet = { keto: false, vegetarian: false, hairGrowthFocus: false },
    avoidTags = [],                 // e.g., ["pork", "allergen:nuts"]
    preferTags = [],                // e.g., ["beef", "eggs", "greens"]
    themes = [],                    // e.g., ["Italian Night", "Taco Tuesday", "Soup Sunday"]
    pantryFirst = true,
    budgetPerDayUSD = null,         // hint for scoring; null = ignore
    macrosTarget = { kcal: 2000, protein: 120, fat: 80, carbs: 150 },
    busyDays = [],                  // array of ISO dates -> choose quick/no-cook meals
    skipSabbath = true,
    sabbathIsSaturday = false,
    season = null,                  // e.g., "Fall" (can bias towards soups/stews)
    planLeftovers = true,           // allow automatic leftover day if scoring fits
    catalogPreferences = {
      enableCatalogBoosts: true,
      sourceBoost: 1,
      preferredDomains: [],
      preferredCatalogIds: [],
      cuisineAffinity: [],
    },
  } = input;

  const cook = await getCookingService();
  const inv = await getInventoryService();

  const inventory = pantryFirst && inv?.snapshot ? await inv.snapshot(input.userId) : { items: [] };
  const recipes = cook ? await cook.listRecipes() : [];
  const catalogRuleSignals = await getCatalogRuleSignals();

  // rank recipes
  const ranked = [];
  for (const r of recipes) {
    const score = await scoreRecipe(r, {
      inventory,
      preferTags,
      avoidTags,
      diet,
      macrosTarget,
      season,
      pantryFirst,
      budgetPerDayUSD,
      catalogPreferences,
      catalogRuleSignals,
    });
    ranked.push({ recipe: r, score });
  }
  ranked.sort((a, b) => b.score - a.score);

  // build day-by-day grid
  const items = [];
  const usedRecipeIds = new Set();
  for (let i = 0; i < days; i++) {
    const date = addDays(startDate, i);
    const sabbath = isHebrewSabbath(date, { skipSabbath, sabbathIsSaturday });
    const dayMeals = [];

    for (const mealType of mealsPerDay) {
      // Sabbath handling: choose no-cook/leftovers or skip cooking event
      if (sabbath && mealType.toLowerCase() === "dinner") {
        dayMeals.push({ type: mealType, planKind: "NO_COOK", label: "No-cook / Leftovers", recipeId: null, servings: people });
        continue;
      }

      // quick meals for busy days
      const quickBias = busyDays.includes(date);

      const pick = pickNextRecipe(ranked, usedRecipeIds, { quickBias, avoidTags });
      if (!pick) {
        dayMeals.push({ type: mealType, planKind: "EMPTY", recipeId: null, servings: people });
        continue;
      }

      usedRecipeIds.add(pick.recipe.id);

      const servings = Math.max(people, pick.recipe.servings || people);
      dayMeals.push({
        type: mealType,
        planKind: "COOK",
        recipeId: pick.recipe.id,
        servings,
      });
    }

    items.push({ date, meals: dayMeals });
  }

  // Optionally mark a leftovers day if enabled and we have enough cooked meals
  if (planLeftovers) {
    const cooked = items.flatMap(d => d.meals).filter(m => m.planKind === "COOK").length;
    if (cooked >= mealsPerDay.length * (days - 1)) {
      // set the last day dinner to leftovers unless Sabbath already no-cook
      const last = items[items.length - 1];
      const dinner = last.meals.find(m => m.type.toLowerCase() === "dinner");
      if (dinner && dinner.planKind === "COOK") {
        dinner.planKind = "LEFTOVERS";
        dinner.recipeId = null;
        dinner.label = "Leftovers Night";
      }
    }
  }

  const plan = {
    id: uid(),
    type: "MEAL_PLAN",
    title,
    people,
    startDate,
    days,
    createdAt: nowISO(),
    updatedAt: nowISO(),
    items,
    prefs: {
      mealsPerDay,
      macrosTarget,
      diet,
      avoidTags,
      preferTags,
      themes,
      pantryFirst,
      budgetPerDayUSD,
      busyDays,
      skipSabbath,
      sabbathIsSaturday,
      season,
      planLeftovers,
    },
    // summaries get filled via summarizePlan() on demand
    summaries: null,
  };

  return plan; // visible draft (persist with savePlan)
}

/**
 * scoreRecipe — higher is better
 * Factors: pantry availability, tag preferences, diet fit, macro proximity, seasonal bump, rough cost.
 */
export async function scoreRecipe(
  recipe,
  {
    inventory,
    preferTags,
    avoidTags,
    diet,
    macrosTarget,
    season,
    pantryFirst,
    budgetPerDayUSD,
    catalogPreferences,
    catalogRuleSignals,
  }
) {
  let score = 0;

  const tags = (recipe.tags || []).map(t => t.toLowerCase());

  const avoidSet = new Set(asArray(avoidTags).map((t) => String(t || "").toLowerCase()));
  if (asArray(avoidTags).some(t => tags.includes(String(t || "").toLowerCase()))) score -= 50;
  if (preferTags.some(t => tags.includes(t.toLowerCase()))) score += 10;

  // Stronger diet compatibility checks so non-compliant recipes sink in ranking.
  const ingredientNames = asArray(recipe.ingredients)
    .map((i) => normalizeText(i?.name || i?.label || ""))
    .filter(Boolean);
  if (diet?.vegetarian) {
    const hasMeat = ingredientNames.some((n) => /(beef|lamb|goat|chicken|turkey|fish|shrimp|pork|bacon)/.test(n));
    if (hasMeat) score -= 40;
    else score += 8;
  }
  if (diet?.keto) {
    const r = await recipeWithNutrition(recipe);
    if (Number.isFinite(Number(r?.nutrition?.carbs)) && Number(r.nutrition.carbs) > 30) score -= 12;
  }

  // Diet heuristics
  if (diet?.keto && tags.includes("keto")) score += 8;
  if (diet?.vegetarian && tags.includes("vegetarian")) score += 8;
  if (diet?.hairGrowthFocus && tags.includes("hair-growth")) score += 6;

  // Pantry-first: add points for ingredients we already have
  if (pantryFirst && inventory?.items?.length) {
    const haveNames = new Map(inventory.items.map(it => [it.name?.toLowerCase(), it]));
    for (const ing of recipe.ingredients || []) {
      const name = (ing.name || "").toLowerCase();
      if (haveNames.has(name)) score += 0.8;
    }
  }

  // Seasonal bump. Increased when farm-to-table/homestead rule sources are present.
  if (season) {
    const seasonalWeight = catalogRuleSignals?.hasSeasonalityRules ? 3 : 2;
    const s = season.toLowerCase();
    if (s === "fall" && tags.some(t => /soup|stew|roast/.test(t))) score += seasonalWeight;
    if (s === "summer" && tags.some(t => /salad|grill|cold/.test(t))) score += seasonalWeight;
  }

  // Macro proximity (if nutrition present or computable)
  const r = await recipeWithNutrition(recipe);
  if (r?.nutrition) {
    const kcalDiff = Math.abs((r.nutrition.kcal || 0) - (macrosTarget.kcal || 0));
    score += Math.max(0, 8 - Math.min(8, kcalDiff / 250)); // closer kcal -> more points
  }

  // Budget hint (rough estimate: lower cost per serving scores higher if budget provided)
  if (budgetPerDayUSD != null) {
    const roughCost = (await estimateRecipeCostUSD(recipe)) / Math.max(1, recipe.servings || 1);
    const ratio = roughCost / Math.max(1, budgetPerDayUSD);
    const budgetWeight = catalogRuleSignals?.hasEstimatorRules ? 1.5 : 1;
    if (ratio <= 0.8) score += 4 * budgetWeight;
    else if (ratio <= 1.0) score += 2 * budgetWeight;
    else score -= 1 * budgetWeight;
  }

  // Prep time preference: shorter is slightly better
  const totalTime = recipe.time?.total || (recipe.time?.prep || 0) + (recipe.time?.cook || 0);
  if (totalTime) score += Math.max(0, 4 - Math.min(4, totalTime / 30));

  // Catalog-aware boosts: domain/id affinity and source preference.
  const cp = catalogPreferences || {};
  const catalog = extractCatalogMeta(recipe);
  if (cp?.enableCatalogBoosts !== false && catalog.isCatalog) {
    score += Number.isFinite(Number(cp?.sourceBoost)) ? Number(cp.sourceBoost) : 1;

    const prefDomains = new Set(
      asArray(cp?.preferredDomains)
        .map((x) => String(x || "").toLowerCase().trim())
        .filter(Boolean)
    );
    const prefIds = new Set(
      asArray(cp?.preferredCatalogIds)
        .map((x) => String(x || "").trim())
        .filter(Boolean)
    );
    const affinity = new Set(
      asArray(cp?.cuisineAffinity)
        .map((x) => String(x || "").toLowerCase().trim())
        .filter(Boolean)
    );

    const domain = String(catalog.catalogDomain || "").toLowerCase();
    if (domain && prefDomains.has(domain)) score += 4;
    if (catalog.catalogId && prefIds.has(String(catalog.catalogId))) score += 5;

    if (affinity.size) {
      const affinityMatch = catalog.tags.some((t) => {
        if (!t.startsWith("catalog:")) return false;
        const suffix = t.replace(/^catalog:/, "");
        return affinity.has(suffix) || affinity.has(suffix.split("/")[0]);
      });
      if (affinityMatch) score += 3;
    }

    if (catalogRuleSignals?.recipeSourceDomains?.size) {
      const cd = String(catalog.catalogDomain || "").toLowerCase();
      if (cd && catalogRuleSignals.recipeSourceDomains.has(cd)) score += 1;
    }
  }

  // Avoid-tag allergen compatibility through shared dictionaries.
  if (avoidSet.size) {
    const allergenIds = await inferRecipeAllergenIds(recipe);
    let allergenConflict = false;
    for (const avoid of avoidSet) {
      if (!avoid.startsWith("allergen:")) continue;
      const aid = avoid.replace(/^allergen:/, "").trim();
      if (allergenIds.has(aid)) {
        allergenConflict = true;
        break;
      }
    }
    if (allergenConflict) score -= 60;
  }

  // Cuisine rules can reinforce explicit preference affinity even for non-catalog recipes.
  if (catalogRuleSignals?.hasCuisineRules) {
    const affinity = new Set(
      asArray(catalogPreferences?.cuisineAffinity)
        .map((x) => String(x || "").toLowerCase().trim())
        .filter(Boolean)
    );
    if (affinity.size) {
      const hasAffinity = tags.some((t) => affinity.has(String(t || "").toLowerCase()));
      if (hasAffinity) score += 2;
    }
  }

  return score;
}

function pickNextRecipe(ranked, used, { quickBias = false, avoidTags = [] } = {}) {
  const candidates = ranked
    .filter(x => !used.has(x.recipe.id))
    .filter(x => !avoidTags.some(t => (x.recipe.tags || []).includes(t)));

  if (candidates.length === 0) return null;

  // weight by score; quickBias prefers recipes with shorter total time
  const weights = candidates.map(c => {
    const totalTime = c.recipe.time?.total || (c.recipe.time?.prep || 0) + (c.recipe.time?.cook || 0);
    const quickFactor = quickBias ? (1 + Math.max(0, (90 - Math.min(90, totalTime))) / 180) : 1;
    return Math.max(0.01, c.score) * quickFactor;
  });

  const sum = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * sum;
  for (let i = 0; i < candidates.length; i++) {
    if ((r -= weights[i]) <= 0) return candidates[i];
  }
  return candidates[candidates.length - 1];
}

async function estimateRecipeCostUSD(recipe) {
  const inv = await getInventoryService();
  const snapshot = inv?.snapshot ? await inv.snapshot() : { items: [] };
  const itemMap = new Map((snapshot.items || []).map(it => [it.name?.toLowerCase(), it]));
  let cost = 0;
  for (const ing of recipe.ingredients || []) {
    const it = itemMap.get((ing.name || "").toLowerCase());
    if (it?.meta?.pricePerUnit && it?.unit && normalizeUnit(it.unit) === normalizeUnit(ing.unit)) {
      cost += (Number(ing.qty) || 0) * Number(it.meta.pricePerUnit);
    } else {
      cost += roughPriceUSD(ing);
    }
  }
  return Math.max(0, Math.round(cost * 100) / 100);
}

// ---- Summaries & grocery -----------------------------------------------------

export async function summarizePlan(plan) {
  const cook = await getCookingService();
  const recipesMap = new Map((await cook.listRecipes()).map(r => [r.id, r]));

  const perDay = [];
  let kcalW = 0, proteinW = 0, fatW = 0, carbsW = 0;

  for (const day of plan.items || []) {
    let kcal = 0, protein = 0, fat = 0, carbs = 0;
    for (const m of day.meals || []) {
      if (!m.recipeId) continue;
      const r = recipesMap.get(m.recipeId);
      if (!r) continue;
      const R = await recipeWithNutrition(r);
      // assume nutrition total for whole recipe; scale by servings chosen ÷ recipe.servings
      const scale = (m.servings || r.servings || 1) / Math.max(1, r.servings || 1);
      kcal += (R.nutrition?.kcal || 0) * scale;
      protein += (R.nutrition?.protein || 0) * scale;
      fat += (R.nutrition?.fat || 0) * scale;
      carbs += (R.nutrition?.carbs || 0) * scale;
    }
    kcalW += kcal; proteinW += protein; fatW += fat; carbsW += carbs;
    perDay.push({ date: day.date, kcal: Math.round(kcal), protein: Math.round(protein), fat: Math.round(fat), carbs: Math.round(carbs) });
  }

  return {
    perDay,
    weeklyTotals: { kcal: Math.round(kcalW), protein: Math.round(proteinW), fat: Math.round(fatW), carbs: Math.round(carbsW) },
  };
}

/**
 * buildGroceryList — delegates to cookingService.buildGroceryList when possible
 * Accepts either a plan object from this service or a cookingService mealPlan.
 */
export async function buildGroceryList(plan) {
  const cook = await getCookingService();
  if (cook?.buildGroceryList) {
    // Convert our plan schema to cookingService plan shape if needed (compatible)
    const compatPlan = {
      id: plan.id,
      items: plan.items,
      title: plan.title,
      startDate: plan.startDate,
      days: plan.days,
    };
    return cook.buildGroceryList(compatPlan);
  }

  // Minimal fallback (no grouping by aisles beyond a couple categories)
  const inv = await getInventoryService();
  const snapshot = inv?.snapshot ? await inv.snapshot() : { items: [] };
  const haveMap = new Map((snapshot.items || []).map(it => [`${(it.name || "").toLowerCase()}::${normalizeUnit(it.unit)}`, it]));

  const cookSvc = await getCookingService();
  const recipesMap = new Map((await cookSvc.listRecipes()).map(r => [r.id, r]));
  const need = [];
  for (const day of plan.items || []) {
    for (const meal of day.meals || []) {
      const r = recipesMap.get(meal.recipeId);
      if (!r) continue;
      for (const ing of r.ingredients || []) {
        const key = `${(ing.name || "").toLowerCase()}::${normalizeUnit(ing.unit)}`;
        const have = haveMap.get(key);
        const haveQty = have ? Number(have.qty) || 0 : 0;
        const needQty = Math.max(0, (Number(ing.qty) || 0) - haveQty);
        if (needQty > 0) need.push({ name: ing.name, qty: needQty, unit: normalizeUnit(ing.unit) });
      }
    }
  }
  return { planId: plan.id, generatedAt: nowISO(), categories: [{ category: "All", items: need }] };
}

// ---- Persistence -------------------------------------------------------------

export async function savePlan(plan) {
  const all = await readJson();
  const id = plan.id || uid();
  const payload = { ...plan, id, updatedAt: nowISO() };
  const idx = all.findIndex(p => p.id === id);
  if (idx >= 0) all[idx] = payload;
  else all.push(payload);
  await writeJson(all);
  return payload;
}
export async function getPlan(id) {
  const all = await readJson();
  return all.find(p => p.id === id) || null;
}
export async function listPlans() {
  const all = await readJson();
  return all.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
}
export async function deletePlan(id) {
  const all = await readJson();
  await writeJson(all.filter(p => p.id !== id));
}

// ---- Leftovers management ----------------------------------------------------

/**
 * markLeftover — mark a cooked meal as producing leftovers (N servings)
 * Later days can reference it with planKind="LEFTOVERS" to avoid grocery spend.
 */
export async function markLeftover({ planId, date, mealType = "Dinner", servings = 2 }) {
  const plan = await getPlan(planId);
  if (!plan) throw new Error("Plan not found");
  plan.leftovers = plan.leftovers || [];
  plan.leftovers.push({ id: uid(), date, mealType, servings });
  plan.updatedAt = nowISO();
  await savePlan(plan);
  return plan.leftovers;
}

// ---- Calendar export (Sabbath-aware cooking events) -------------------------

export async function scheduleOnCalendar(opts) {
  const {
    planId,
    provider = "local",
    calendarId = "primary",
    timezone = "America/New_York",
    eventTitlePrefix = "Meal •",
    skipSabbath = true,
    sabbathIsSaturday = false,
  } = opts || {};

  const plan = await getPlan(planId);
  if (!plan) throw new Error("Meal plan not found");

  const cook = await getCookingService();
  const recipesMap = new Map((await cook.listRecipes()).map(r => [r.id, r]));

  const events = [];
  for (const day of plan.items || []) {
    for (const m of day.meals || []) {
      const sabbath = isHebrewSabbath(day.date, { skipSabbath, sabbathIsSaturday });
      const r = m.recipeId ? recipesMap.get(m.recipeId) : null;
      const titleRecipe = r ? r.title : (m.label || m.planKind || "Meal");
      const title = `${eventTitlePrefix} ${titleRecipe}`;

      // If Sabbath, make it an all-day informational event (no cooking block).
      const duration = sabbath ? 15 : 90;
      const desc =
        sabbath
          ? `No-cook / Reheat • ${titleRecipe} • Servings: ${m.servings || (r?.servings || 1)}`
          : `Cook • ${titleRecipe} • Servings: ${m.servings || (r?.servings || 1)}`;

      events.push({
        title,
        description: desc,
        start: day.date, // all-day; client can map to preferred time block if needed
        durationMinutes: duration,
        timezone,
        recurrence: null,
        meta: { planId: plan.id, mealType: m.type, recipeId: m.recipeId || null, sabbath },
      });
    }
  }

  const cal = await getCalendarService();
  if (!cal?.createEventsBatch) return events; // visible preview for UI

  return cal.createEventsBatch({ provider, calendarId, events });
}

// ---- Public helpers for UI flows --------------------------------------------

/**
 * regenerateGroceryForPlan — convenience to rebuild grocery list after edits.
 */
export async function regenerateGroceryForPlan(planId) {
  const plan = await getPlan(planId);
  if (!plan) throw new Error("Plan not found");
  return buildGroceryList(plan);
}

/**
 * updateMeal — change a single meal entry (swap recipe, servings, kind)
 */
export async function updateMeal({ planId, date, mealType, patch }) {
  const plan = await getPlan(planId);
  if (!plan) throw new Error("Plan not found");
  const day = (plan.items || []).find(d => d.date === date);
  if (!day) throw new Error("Day not found in plan");
  const meal = (day.meals || []).find(m => m.type === mealType);
  if (!meal) throw new Error("Meal type not found");
  Object.assign(meal, patch || {});
  plan.updatedAt = nowISO();
  await savePlan(plan);
  return meal;
}

// ---- n8n payload -------------------------------------------------------------

export function buildN8nPayload(entity, opts = {}) {
  const base = {
    id: entity?.id,
    type: entity?.type || "MEAL_PLAN",
    title: entity?.title,
    createdAt: entity?.createdAt,
    updatedAt: entity?.updatedAt,
  };
  return {
    ...base,
    startDate: entity?.startDate,
    days: entity?.days,
    people: entity?.people,
    items: entity?.items,
    prefs: entity?.prefs,
    summaries: entity?.summaries || null,
    options: opts,
  };
}

// ---- Default export ----------------------------------------------------------

const MealPlanService = {
  // generation & summaries
  generatePlan,
  scoreRecipe,
  summarizePlan,

  // grocery
  buildGroceryList,
  regenerateGroceryForPlan,

  // persistence
  savePlan,
  getPlan,
  listPlans,
  deletePlan,

  // edits
  updateMeal,
  markLeftover,

  // calendar
  scheduleOnCalendar,

  // n8n
  buildN8nPayload,
};

export default MealPlanService;
