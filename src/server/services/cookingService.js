// C:\Users\larho\suka-smart-assistant\src\server\services\cookingService.js
//
// Suka Smart Assistant — Cooking Service
//
// Purpose:
//   Provider-agnostic helpers for /api/cooking routes, agents, and n8n flows.
//   Bridges Recipe Vault ⇄ Batch Sessions ⇄ Inventory ⇄ Calendar, with
//   "visible draft" payloads for UI preview/edit prior to save.
//
// Key Features from project chats:
//   • Recipe Vault with tag/search + drag/checkbox add-to-batch
//   • Batch Session builder: multitimer blueprint, integrated step parser,
//     prep checklist generator, label printer payloads
//   • Inventory sync (auto-link ingredients ⇄ inventory items)
//   • Grocery List generator (grouped, delta vs inventory)
//   • Preservation trackers (pressure canning, curing, freezing, dehydrating,
//     sausage making, winemaking, beer brewing, distilling)
//   • Nutrition + macros hooks (keto/IF friendly; hair-growth plan support)
//   • Calendar scheduling with Hebrew Day 7 Sabbath skip (default)
//   • n8n-friendly compact payloads
//
// Storage: local JSON store (great for dev/offline). Optional bridges to
//          calendarService, inventoryService, nutritionLookupService.
//
// Exports (summary):
//   - upsertRecipe(recipe) / getRecipe(id) / listRecipes(query?) / deleteRecipe(id)
//   - scanRecipe(text, opts) -> parsed recipe draft (visible)
//   - generateMealPlan(input) -> visible weekly/season plan
//   - buildGroceryList(plan, inventorySnapshot?) -> grouped delta list
//   - createBatchSession(input) / updateBatchProgress(id, updates) / listBatchSessions()
//   - syncInventoryForBatch(id, action)  // "reserve" | "consume" | "rollback" | "preserve"
//   - suggestPreservationMethods(recipe | outputs[]) -> methods
//   - schedulePlanOnCalendar(opts) -> events[] (uses calendarService if present)
//   - buildLabelsForBatch(id) -> label/QR payloads
//   - buildN8nPayload(entity, opts)
//
// ------------------------------------------------------------------------------

import fs from "fs/promises";
import path from "path";
import crypto from "crypto";

// ---- Lazy bridges (avoid circular deps) -------------------------------------
let calendarService = null;
let inventoryService = null;
let nutritionLookupService = null;

async function getCalendarService() {
  if (!calendarService) {
    const mod = await import("./calendarService.js").catch(() => null);
    calendarService = mod ? mod.default || mod : null;
  }
  return calendarService;
}
async function getInventoryService() {
  if (!inventoryService) {
    const mod = await import("./inventoryService.js").catch(() => null);
    inventoryService = mod ? mod.default || mod : null;
  }
  return inventoryService;
}
async function getNutritionService() {
  if (!nutritionLookupService) {
    const mod = await import("../../features/nutrition/services/nutritionLookupService.js").catch(() => null);
    nutritionLookupService = mod ? mod.default || mod : null;
  }
  return nutritionLookupService;
}

// ---- Local JSON store -------------------------------------------------------
const DATA_DIR = path.resolve(process.cwd(), "data", "cooking");
const FILES = {
  recipes: path.join(DATA_DIR, "recipes.json"),
  mealPlans: path.join(DATA_DIR, "mealPlans.json"),
  batchSessions: path.join(DATA_DIR, "batchSessions.json"),
};

async function ensureStore() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  for (const f of Object.values(FILES)) {
    try { await fs.access(f); }
    catch { await fs.writeFile(f, JSON.stringify([], null, 2), "utf-8"); }
  }
}
async function readJson(file) {
  await ensureStore();
  const raw = await fs.readFile(file, "utf-8");
  return JSON.parse(raw || "[]");
}
async function writeJson(file, data) {
  await ensureStore();
  await fs.writeFile(file, JSON.stringify(data, null, 2), "utf-8");
}

// ---- Utilities --------------------------------------------------------------
const uid = () => crypto.randomUUID();
const nowISO = () => new Date().toISOString();
const coalesce = (a, b) => (typeof a === "undefined" ? b : a);

function hebrewDayIsSabbathSkip(isoDate, opts) {
  // Placeholder: treat Saturday as Sabbath for skip rules unless overridden by Hebrew core.
  const defaultSkip = coalesce(opts?.skipSabbath, true);
  const useSaturday = coalesce(opts?.sabbathIsSaturday, false);
  if (!defaultSkip) return false;
  const d = new Date(isoDate);
  const dow = d.getUTCDay(); // 6 = Saturday
  return useSaturday ? dow === 6 : dow === 6;
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
  return s;
}

function groupByCategory(items) {
  const map = new Map();
  for (const it of items) {
    const cat = it.category || "Other";
    const arr = map.get(cat) || [];
    arr.push(it);
    map.set(cat, arr);
  }
  return Array.from(map.entries()).map(([category, lines]) => ({ category, items: lines }));
}

const DEFAULT_CATEGORIES = [
  "Produce", "Meat", "Seafood", "Dairy", "Eggs", "Pantry", "Baking",
  "Oils/Vinegars", "Spices", "Frozen", "Beverages", "Other",
];

// ---- Nutrition/macros heuristics (hooks to nutrition service) ---------------
async function computeRecipeNutrition(recipe) {
  const svc = await getNutritionService();
  if (svc?.lookupIngredients) {
    return svc.lookupIngredients(recipe.ingredients || [], {
      // options aligned with your nutrition module
      preferUS: true,
      fallbackSimpleHeuristics: true,
    });
  }
  // Fallback basic sum if nutrition service not present
  const per100g = { kcal: 200, protein: 12, fat: 10, carbs: 8 }; // generic heuristic
  let gramsTotal = 0;
  for (const ing of recipe.ingredients || []) {
    const qty = Number(ing.qty) || 0;
    const unit = normalizeUnit(ing.unit);
    const guessG =
      unit === "g" ? qty :
      unit === "kg" ? qty * 1000 :
      unit === "lb" ? qty * 453.6 :
      unit === "oz" ? qty * 28.35 :
      unit === "ml" ? qty : // assume density ~ water
      unit === "cup" ? qty * 240 :
      unit === "tbsp" ? qty * 15 :
      unit === "tsp" ? qty * 5 :
      qty * 50; // arbitrary per "unit"
    gramsTotal += guessG;
  }
  const factor = gramsTotal / 100;
  return {
    kcal: Math.round(per100g.kcal * factor),
    protein: Math.round(per100g.protein * factor),
    fat: Math.round(per100g.fat * factor),
    carbs: Math.round(per100g.carbs * factor),
    servings: recipe.servings || 1,
  };
}

// ---- Recipe Vault -----------------------------------------------------------
export async function upsertRecipe(recipe) {
  const all = await readJson(FILES.recipes);
  const now = nowISO();
  let rec = recipe;

  if (!rec.id) rec.id = uid();
  rec.createdAt = rec.createdAt || now;
  rec.updatedAt = now;

  // Normalize shape
  rec = {
    id: rec.id,
    title: rec.title || "Untitled Recipe",
    source: rec.source || null,
    tags: rec.tags || [],
    servings: rec.servings || 4,
    time: { prep: rec.time?.prep || 10, cook: rec.time?.cook || 20, total: rec.time?.total || ((rec.time?.prep || 10) + (rec.time?.cook || 20)) },
    ingredients: (rec.ingredients || []).map((i) => ({
      name: i.name,
      qty: Number(i.qty) || i.qty || 0,
      unit: normalizeUnit(i.unit),
      note: i.note || "",
      // inventory linking
      inventoryItemId: i.inventoryItemId || null,
      category: i.category || null,
    })),
    steps: rec.steps || [],
    equipment: rec.equipment || [],
    notes: rec.notes || "",
    nutrition: rec.nutrition || await computeRecipeNutrition(rec),
    preservation: rec.preservation || { suggested: [], shelfLifeDays: null },
    images: rec.images || [],
  };

  const idx = all.findIndex((r) => r.id === rec.id);
  if (idx >= 0) all[idx] = rec;
  else all.push(rec);
  await writeJson(FILES.recipes, all);
  return rec;
}

export async function getRecipe(id) {
  const all = await readJson(FILES.recipes);
  return all.find((r) => r.id === id) || null;
}
export async function listRecipes(query = {}) {
  const all = await readJson(FILES.recipes);
  const q = (query.q || "").toLowerCase();
  const tag = query.tag || null;
  const out = all.filter((r) => {
    const okQ = !q || r.title.toLowerCase().includes(q) || r.tags.join(" ").toLowerCase().includes(q);
    const okTag = !tag || r.tags.includes(tag);
    return okQ && okTag;
  });
  return out.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
}
export async function deleteRecipe(id) {
  const all = await readJson(FILES.recipes);
  await writeJson(FILES.recipes, all.filter((r) => r.id !== id));
}

// Simple parser stub to support your Recipe Scanner UI
export async function scanRecipe(text, opts = {}) {
  // Extremely lightweight lines-based parser; your client RecipeScanner can refine this.
  const lines = (text || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const title = lines[0] || "Scanned Recipe";
  const ingredientsStart = lines.findIndex((l) => /^ingredients?/i.test(l));
  const stepsStart = lines.findIndex((l) => /^steps?|^directions?/i.test(l));

  const ingredients = [];
  const steps = [];

  if (ingredientsStart >= 0) {
    const end = stepsStart >= 0 ? stepsStart : lines.length;
    for (let i = ingredientsStart + 1; i < end; i++) {
      const row = lines[i];
      const m = row.match(/^(\d+(?:[\./]\d+)?)\s*([a-zA-Z]+)?\s+(.*)$/);
      ingredients.push({
        name: m ? m[3] : row,
        qty: m ? Number(m[1]) : null,
        unit: m ? normalizeUnit(m[2]) : null,
        note: "",
        inventoryItemId: null,
        category: null,
      });
    }
  }
  if (stepsStart >= 0) {
    for (let i = stepsStart + 1; i < lines.length; i++) steps.push(lines[i]);
  }

  const draft = {
    id: uid(),
    title,
    servings: opts.servings || 4,
    time: { prep: 10, cook: 20, total: 30 },
    ingredients,
    steps,
    tags: opts.tags || [],
    notes: "",
    images: [],
  };
  draft.nutrition = await computeRecipeNutrition(draft);
  return draft; // visible draft for UI confirmation
}

// ---- Meal Plans -------------------------------------------------------------
export async function generateMealPlan(input) {
  const {
    title = "Weekly Meal Plan",
    startDate = new Date().toISOString().slice(0, 10),
    days = 7,
    people = 4,
    macrosTarget = { kcal: 2000, protein: 120, fat: 80, carbs: 150 }, // user can override / keto variants
    diet = { keto: false, hairGrowthFocus: false }, // aligns with prior chats
    avoidTags = [], // e.g., ["pork", "allergen:nuts"]
    preferTags = [], // e.g., ["beef", "eggs", "greens"]
    season = null, // e.g., "Fall" -> future: garden harvest tie-in
  } = input || {};

  const recipes = await listRecipes();
  // Very simple selector: prefer tags, exclude avoid, then fill.
  const preferred = recipes.filter(r => preferTags.some(t => r.tags.includes(t)));
  const allowed = recipes.filter(r => !avoidTags.some(t => r.tags.includes(t)));
  const pool = [...new Set([...preferred, ...allowed])];

  const planDays = [];
  for (let i = 0; i < days; i++) {
    const date = new Date(startDate);
    date.setDate(date.getDate() + i);
    const pick = pool[i % pool.length] || recipes[i % recipes.length];
    if (!pick) break;

    // Basic macro suggestion per person; divide recipe servings as needed
    const servingsPerPerson = Math.max(1, Math.round((pick.servings || 4) / people));
    planDays.push({
      date: date.toISOString().slice(0, 10),
      meals: [
        { type: "Dinner", recipeId: pick.id, servingsPerPerson },
      ],
      macroTargets: macrosTarget,
    });
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
    items: planDays,
    prefs: { macrosTarget, diet, season, avoidTags, preferTags },
  };

  // Save immediately as a draft plan
  const all = await readJson(FILES.mealPlans);
  all.push(plan);
  await writeJson(FILES.mealPlans, all);
  return plan;
}

export async function listMealPlans() {
  const all = await readJson(FILES.mealPlans);
  return all.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
}
export async function getMealPlan(id) {
  const all = await readJson(FILES.mealPlans);
  return all.find((p) => p.id === id) || null;
}

// ---- Grocery List (Inventory-aware) ----------------------------------------
export async function buildGroceryList(plan, inventorySnapshot = null) {
  const invSvc = await getInventoryService();
  const inventory = inventorySnapshot || (invSvc?.snapshot ? await invSvc.snapshot() : { items: [] });

  // Collect ingredient lines across the plan
  const need = [];
  for (const day of plan.items || []) {
    for (const meal of day.meals || []) {
      const rec = await getRecipe(meal.recipeId);
      if (!rec) continue;
      for (const ing of rec.ingredients) {
        // scale by servings? use simple factor (future: per meal scaling UI)
        need.push({
          name: ing.name,
          qty: Number(ing.qty) || 0,
          unit: normalizeUnit(ing.unit),
          category: ing.category || mapCategory(ing.name),
          recipeId: rec.id,
          date: day.date,
        });
      }
    }
  }

  // Aggregate by (name+unit)
  const aggMap = new Map();
  for (const line of need) {
    const key = `${line.name.toLowerCase()}::${line.unit}`;
    const prev = aggMap.get(key) || { ...line, qty: 0, recipes: [] };
    prev.qty += line.qty || 0;
    prev.recipes.push(line.recipeId);
    aggMap.set(key, prev);
  }
  const aggregated = Array.from(aggMap.values());

  // Subtract inventory
  const delta = aggregated.map((line) => {
    const onHand = inventory.items?.find((it) => it.name?.toLowerCase() === line.name.toLowerCase() && normalizeUnit(it.unit) === line.unit);
    const haveQty = onHand ? Number(onHand.qty) || 0 : 0;
    const needQty = Math.max(0, (Number(line.qty) || 0) - haveQty);
    return { ...line, haveQty, needQty };
  });

  const filtered = delta.filter((d) => d.needQty > 0);

  // Group by category for UI
  const grouped = groupByCategory(filtered);
  return {
    planId: plan.id,
    generatedAt: nowISO(),
    categories: DEFAULT_CATEGORIES.map((c) => grouped.find(g => g.category === c) || { category: c, items: [] })
      .concat(grouped.filter(g => !DEFAULT_CATEGORIES.includes(g.category))),
  };
}

function mapCategory(name = "") {
  const n = name.toLowerCase();
  if (/(lettuce|greens|spinach|kale|onion|garlic|pepper|tomato|carrot|celery|broccoli|apple|banana|berry)/.test(n)) return "Produce";
  if (/(beef|lamb|goat|pork|chicken|turkey)/.test(n)) return "Meat";
  if (/(salmon|mackerel|fish|shrimp|tuna|sardine)/.test(n)) return "Seafood";
  if (/(milk|cheese|yogurt|cream)/.test(n)) return "Dairy";
  if (/(egg)/.test(n)) return "Eggs";
  if (/(flour|rice|pasta|beans|lentil|oat|quinoa)/.test(n)) return "Pantry";
  if (/(baking|yeast|soda|powder|sugar)/.test(n)) return "Baking";
  if (/(olive oil|avocado oil|vinegar)/.test(n)) return "Oils/Vinegars";
  if (/(salt|pepper|paprika|cumin|spice|season)/.test(n)) return "Spices";
  if (/(frozen)/.test(n)) return "Frozen";
  if (/(water|juice|tea|coffee)/.test(n)) return "Beverages";
  return "Other";
}

// ---- Batch Cooking Sessions -------------------------------------------------
export async function createBatchSession(input) {
  const {
    title = "Batch Cooking Session",
    recipeIds = [],
    startAt = null,
    timersEnabled = true,
    voiceCues = true,
    generatePrepChecklist = true,
    generateLabels = true,
    assignToRole = null, // e.g., "Adult 1", "Teen Helper"
    notes = "",
  } = input || {};

  const recipes = await Promise.all(recipeIds.map(getRecipe));
  const valid = recipes.filter(Boolean);

  const integratedSteps = integrateSteps(valid);
  const multitimer = buildMultiTimerBlueprint(integratedSteps);

  const session = {
    id: uid(),
    type: "BATCH_SESSION",
    title,
    recipeIds: valid.map((r) => r.id),
    createdAt: nowISO(),
    updatedAt: nowISO(),
    config: {
      startAt,
      timersEnabled,
      voiceCues,
      assignToRole,
    },
    artifacts: {
      integratedSteps,
      prepChecklist: generatePrepChecklist ? buildPrepChecklist(valid) : [],
      labels: generateLabels ? buildLabelDrafts(valid) : [],
      multitimer,
    },
    progress: {
      startedAt: null,
      endedAt: null,
      stepPointer: 0,
      completedSteps: [],
      inventorySync: "pending", // "reserved" | "consumed" | "rolledback" | "preserved"
    },
    notes,
  };

  const all = await readJson(FILES.batchSessions);
  all.push(session);
  await writeJson(FILES.batchSessions, all);
  return session;
}

export async function updateBatchProgress(id, updates = {}) {
  const all = await readJson(FILES.batchSessions);
  const idx = all.findIndex((s) => s.id === id);
  if (idx < 0) throw new Error("Batch session not found");
  const now = nowISO();
  const prev = all[idx];
  const next = {
    ...prev,
    progress: { ...prev.progress, ...updates },
    updatedAt: now,
  };
  all[idx] = next;
  await writeJson(FILES.batchSessions, all);
  return next;
}

export async function listBatchSessions() {
  const all = await readJson(FILES.batchSessions);
  return all.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
}
export async function getBatchSession(id) {
  const all = await readJson(FILES.batchSessions);
  return all.find((s) => s.id === id) || null;
}

// ---- Integrated Steps / Timers / Prep / Labels ------------------------------
function integrateSteps(recipes) {
  // Merge steps with tags for parallelization and dependencies.
  // Your client "Integrated Task Parser" can enhance this with NLP later.
  let idx = 0;
  const out = [];
  for (const r of recipes) {
    for (const [i, step] of (r.steps || []).entries()) {
      out.push({
        id: `stp_${++idx}`,
        recipeId: r.id,
        recipeTitle: r.title,
        text: step,
        // naive tags:
        tags: inferStepTags(step),
        estMinutes: estimateStepMinutes(step),
        requiresTimer: /\b(bake|simmer|boil|rest|proof|freeze|cure|dehydrate|brew|ferment)\b/i.test(step),
      });
    }
  }
  // Reorder with simple heuristic: prep → cook → rest/finish
  return out.sort((a, b) => orderWeight(a) - orderWeight(b));
}
function orderWeight(s) {
  const t = s.text.toLowerCase();
  if (/(chop|dice|slice|prep|preheat|sanitize|sterilize|mix|season)/.test(t)) return 10;
  if (/(sear|saute|brown|boil|bake|simmer|pressure|can|can(?:ning)?)/.test(t)) return 20;
  if (/(rest|cool|proof|ferment|freeze|cure|dehydrate|bottle|label)/.test(t)) return 30;
  return 25;
}
function inferStepTags(step) {
  const t = step.toLowerCase();
  const tags = [];
  if (/preheat/.test(t)) tags.push("preheat");
  if (/(chop|dice|slice|mince)/.test(t)) tags.push("knife-prep");
  if (/(mix|whisk|combine)/.test(t)) tags.push("mix");
  if (/(bake|roast)/.test(t)) tags.push("oven");
  if (/(boil|simmer)/.test(t)) tags.push("stovetop");
  if (/(pressure|can)/.test(t)) tags.push("pressure-canning");
  if (/(dehydrate)/.test(t)) tags.push("dehydrating");
  if (/(cure|smoke)/.test(t)) tags.push("curing");
  if (/(brew|ferment)/.test(t)) tags.push("brewing");
  if (/(label|jar|bottle)/.test(t)) tags.push("packaging");
  return tags;
}
function estimateStepMinutes(step) {
  const t = step.toLowerCase();
  if (/preheat/.test(t)) return 10;
  if (/(chop|dice|mince|slice)/.test(t)) return 8;
  if (/(mix|whisk)/.test(t)) return 4;
  if (/(simmer)/.test(t)) return 20;
  if (/(boil)/.test(t)) return 12;
  if (/(bake|roast)/.test(t)) return 30;
  if (/(pressure|can)/.test(t)) return 45;
  if (/(dehydrate)/.test(t)) return 240;
  if (/(cure|smoke)/.test(t)) return 480;
  if (/(brew|ferment)/.test(t)) return 1440;
  return 6;
}

function buildMultiTimerBlueprint(steps) {
  // Group steps that request timers
  const timers = [];
  let id = 0;
  for (const s of steps) {
    if (!s.requiresTimer) continue;
    timers.push({
      id: `tmr_${++id}`,
      stepId: s.id,
      label: `${s.recipeTitle}: ${shorten(s.text, 32)}`,
      minutes: s.estMinutes,
      // Frontend handles voice alerts + toast notifications (per your spec)
    });
  }
  return { timers };
}

function buildPrepChecklist(recipes) {
  // Flatten ingredients and equipment
  const ingredients = [];
  const equipment = new Set();
  for (const r of recipes) {
    (r.ingredients || []).forEach((i) => {
      ingredients.push({
        recipeId: r.id,
        recipeTitle: r.title,
        name: i.name, qty: i.qty, unit: normalizeUnit(i.unit),
      });
    });
    (r.equipment || []).forEach((e) => equipment.add(e));
  }
  // Aggregate ingredient lines
  const map = new Map();
  for (const i of ingredients) {
    const key = `${i.name.toLowerCase()}::${i.unit}`;
    const prev = map.get(key) || { ...i, qty: 0, recipes: [] };
    prev.qty += Number(i.qty) || 0;
    prev.recipes.push(i.recipeId);
    map.set(key, prev);
  }
  return {
    ingredients: Array.from(map.values()),
    equipment: Array.from(equipment.values()),
    sanitation: [
      "Sanitize surfaces",
      "Lay out clean towels/racks",
      "Pre-label jars/bags",
      "Preheat oven/sterilize jars if canning",
    ],
  };
}

function buildLabelDrafts(recipes) {
  const out = [];
  let id = 0;
  for (const r of recipes) {
    const base = r.title.replace(/\s+/g, "-").toLowerCase().slice(0, 24);
    out.push({
      id: `lbl_${++id}`,
      title: r.title,
      // Default label schema—frontend Label Printer can add QR with recipeId + batchId
      fields: {
        name: r.title,
        madeOn: new Date().toISOString().slice(0, 10),
        contents: r.title,
        batchCode: `${base}-${Date.now().toString().slice(-6)}`,
        storage: suggestDefaultStorage(r),
        useBy: suggestUseByDate(r),
      },
    });
  }
  return out;
}
export async function buildLabelsForBatch(batchId) {
  const s = await getBatchSession(batchId);
  if (!s) throw new Error("Batch not found");
  const recipes = await Promise.all((s.recipeIds || []).map(getRecipe));
  return buildLabelDrafts(recipes.filter(Boolean));
}

function suggestDefaultStorage(recipe) {
  const tgs = (recipe.tags || []).join(" ").toLowerCase();
  if (/(pickle|canned|pressure)/.test(tgs)) return "Pantry (cool, dark)";
  if (/(ferment|kimchi|sauerkraut|brew)/.test(tgs)) return "Refrigerated";
  if (/(sausage|meat|smoke|cure)/.test(tgs)) return "Freezer";
  return "Refrigerated";
}
function suggestUseByDate(recipe) {
  // Simple heuristic: canned 12–18 mo; refrigerated 3–7 d; freezer 2–6 mo
  const storage = suggestDefaultStorage(recipe);
  const d = new Date();
  if (/Pantry/.test(storage)) { d.setMonth(d.getMonth() + 15); }
  else if (/Freezer/.test(storage)) { d.setMonth(d.getMonth() + 4); }
  else { d.setDate(d.getDate() + 5); }
  return d.toISOString().slice(0, 10);
}

// ---- Inventory Sync for Batch Sessions -------------------------------------
export async function syncInventoryForBatch(batchId, action = "reserve") {
  const inv = await getInventoryService();
  if (!inv) return { status: "noop", reason: "inventoryService not available" };

  const s = await getBatchSession(batchId);
  if (!s) throw new Error("Batch not found");

  const recipes = await Promise.all((s.recipeIds || []).map(getRecipe));
  const lines = [];
  for (const r of recipes) {
    for (const i of r.ingredients || []) {
      lines.push({ name: i.name, qty: Number(i.qty) || 0, unit: normalizeUnit(i.unit), recipeId: r.id });
    }
  }

  // Dispatch to inventory service according to action
  let result = null;
  if (action === "reserve" && inv.reserveBulk) result = await inv.reserveBulk(lines, { batchId });
  if (action === "consume" && inv.consumeBulk) result = await inv.consumeBulk(lines, { batchId });
  if (action === "rollback" && inv.rollbackReservation) result = await inv.rollbackReservation({ batchId });
  if (action === "preserve" && inv.addProducedBulk) {
    // Add outputs (labels become SKUs). For now, assume one unit per recipe.
    const labels = await buildLabelsForBatch(batchId);
    const outputs = labels.map((l) => ({ name: l.fields.contents, qty: 1, unit: "unit", location: "Root Cellar/Freezer", meta: l.fields }));
    result = await inv.addProducedBulk(outputs, { batchId });
  }

  // Update session progress flag
  await updateBatchProgress(batchId, {
    inventorySync:
      action === "reserve" ? "reserved" :
      action === "consume" ? "consumed" :
      action === "rollback" ? "rolledback" :
      action === "preserved" ? "preserved" : s.progress?.inventorySync,
  });

  return { status: "ok", action, result };
}

// ---- Preservation Suggestions -----------------------------------------------
export function suggestPreservationMethods(input) {
  const items = Array.isArray(input) ? input : (input?.ingredients || []);
  const methods = new Set();
  for (const it of items) {
    const n = (it.name || "").toLowerCase();
    if (/(tomato|pepper|apple|peach|pickle|green bean)/.test(n)) methods.add("Pressure Canning");
    if (/(beef|lamb|goat|sausage)/.test(n)) methods.add("Curing/Smoking");
    if (/(herb|mushroom|jerky)/.test(n)) methods.add("Dehydrating");
    if (/(berry|fruit|stock|broth)/.test(n)) methods.add("Freezing");
    if (/(cabbage|kimchi|kraut|pickle|kombucha)/.test(n)) methods.add("Fermenting/Brewing");
  }
  return Array.from(methods.values());
}

// ---- Calendar Scheduling (Sabbath-aware) -----------------------------------
export async function schedulePlanOnCalendar(opts) {
  const {
    planId,
    provider = "local",
    calendarId = "primary",
    timezone = "America/New_York",
    skipSabbath = true,
    sabbathIsSaturday = false,
    eventTitlePrefix = "Meal •",
  } = opts || {};

  const plan = await getMealPlan(planId);
  if (!plan) throw new Error("Meal plan not found");

  const cal = await getCalendarService();
  const events = [];

  for (const day of plan.items || []) {
    if (skipSabbath && hebrewDayIsSabbathSkip(day.date, { skipSabbath, sabbathIsSaturday })) {
      continue;
    }
    for (const meal of day.meals || []) {
      const r = await getRecipe(meal.recipeId);
      if (!r) continue;
      events.push({
        title: `${eventTitlePrefix} ${r.title}`,
        description: `Auto-generated by Suka • Plan: ${plan.title}\nServings: ${r.servings}`,
        start: day.date, // all-day; calendarService can map to preferred time block
        durationMinutes: 90,
        timezone,
        recurrence: null,
        meta: { planId: plan.id, recipeId: r.id, mealType: meal.type },
      });
    }
  }

  if (!cal?.createEventsBatch) return events; // visible preview for UI

  return cal.createEventsBatch({ provider, calendarId, events });
}

// ---- n8n Payloads -----------------------------------------------------------
export function buildN8nPayload(entity, opts = {}) {
  const base = {
    id: entity?.id,
    type: entity?.type,
    title: entity?.title,
    createdAt: entity?.createdAt,
    updatedAt: entity?.updatedAt,
  };

  if (entity?.type === "MEAL_PLAN") {
    return {
      ...base,
      startDate: entity.startDate,
      days: entity.days,
      people: entity.people,
      items: entity.items,
      prefs: entity.prefs,
      options: opts,
    };
  }

  if (entity?.type === "BATCH_SESSION") {
    return {
      ...base,
      recipeIds: entity.recipeIds,
      config: entity.config,
      progress: entity.progress,
      artifacts: {
        prepChecklist: entity.artifacts?.prepChecklist,
        labels: entity.artifacts?.labels?.map(l => ({ id: l.id, fields: l.fields })),
        multitimer: entity.artifacts?.multitimer,
        stepCount: entity.artifacts?.integratedSteps?.length || 0,
      },
      options: opts,
    };
  }

  return { ...base, options: opts };
}

// ---- Default export ---------------------------------------------------------
const CookingService = {
  // Recipes
  upsertRecipe,
  getRecipe,
  listRecipes,
  deleteRecipe,
  scanRecipe,

  // Meal Plans
  generateMealPlan,
  listMealPlans,
  getMealPlan,

  // Grocery List
  buildGroceryList,

  // Batch Sessions + artifacts
  createBatchSession,
  updateBatchProgress,
  listBatchSessions,
  getBatchSession,
  syncInventoryForBatch,
  suggestPreservationMethods,
  buildLabelsForBatch,

  // Calendar
  schedulePlanOnCalendar,

  // n8n
  buildN8nPayload,
};

export default CookingService;
