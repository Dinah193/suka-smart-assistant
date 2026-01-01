// src/features/nutrition/services/mealPlanMap.js

/**
 * Meal Plan Map – Core Service
 * -----------------------------------------------------------------------------
 * Turns (macroPlan, recipes, inventory, prefs) => structured meal plan
 * - Per-meal macro targets (from calories, % or grams)
 * - Recipe matching with a macro score + heuristic constraints
 * - Bin-packing recipes into days x meals
 * - Grocery diff vs. inventory; batch-cooking suggestions
 * - Torah-allowed foods filter; hair-growth friendly tag nudges if desired
 *
 * Events listened:
 *  - "suka:macroPlanApplied"  { plan }
 *  - "suka:recipesImported"   { recipes }
 *  - "suka:groceryListMerge"  { items }
 *
 * Event emitted:
 *  - "suka:mealPlanGenerated" { plan, context }
 *
 * Safe: Works standalone (no stores required). If stores exist, they’re used.
 */

const STORAGE_KEY = "mealPlanMap:last";
const DEFAULT_DAYS = 7;
const DEFAULT_MEALS_PER_DAY = 3;

/* --------------------------------- Utils ---------------------------------- */

const uid = () => Math.random().toString(36).slice(2, 10);
const clamp = (n, a, b) => Math.min(b, Math.max(a, Number.isFinite(n) ? n : 0));
const round0 = (n) => Math.round(n || 0);
const sum = (arr) => arr.reduce((a, b) => a + (Number(b) || 0), 0);

function kcalFromMacros({ protein = 0, fat = 0, carbs = 0 }) {
  return protein * 4 + carbs * 4 + fat * 9;
}

function splitPerMeal(targets, mealsPerDay) {
  const m = clamp(mealsPerDay || DEFAULT_MEALS_PER_DAY, 1, 8);
  return {
    protein: (targets.protein || 0) / m,
    fat: (targets.fat || 0) / m,
    carbs: (targets.carbs || 0) / m,
    kcal: kcalFromMacros(targets) / m,
  };
}

function cosineLike(a, b) {
  // simple similarity for macro vectors (protein, fat, carbs) by grams
  const ax = [a.protein || 0, a.fat || 0, a.carbs || 0];
  const bx = [b.protein || 0, b.fat || 0, b.carbs || 0];
  const dot = ax[0] * bx[0] + ax[1] * bx[1] + ax[2] * bx[2];
  const na = Math.hypot(ax[0], ax[1], ax[2]) || 1;
  const nb = Math.hypot(bx[0], bx[1], bx[2]) || 1;
  return dot / (na * nb);
}

/* -------------------------- Torah / Preference Rules ----------------------- */

/**
 * isTorahAllowed(recipe): returns true if recipe appears compliant.
 * This is heuristic-based using tags/ingredients. You can strengthen with your rules engine.
 */
function isTorahAllowed(recipe) {
  const forbidTokens = [
    "pork", "bacon", "ham", "prosciutto",
    "shrimp", "lobster", "crab", "clam", "oyster", "mussel", "scallop",
    "catfish"
  ];
  const txt =
    [
      recipe?.title || "",
      ...(recipe?.ingredients || []),
      ...(recipe?.tags || []),
    ]
      .join(" ")
      .toLowerCase();

  return !forbidTokens.some((w) => txt.includes(w));
}

/**
 * preferenceBoost(recipe, prefs): returns bonus based on user patterns.
 * Example prefs: { preferMeats:["lamb","beef","goat"], avoid:["dairy"], tagsUp:["hair-growth"], tagsDown:["fried"] }
 */
function preferenceBoost(recipe, prefs = {}) {
  let boost = 0;
  const hay = [
    (recipe?.title || "").toLowerCase(),
    ...(recipe?.ingredients || []).map((s) => String(s).toLowerCase()),
    ...(recipe?.tags || []).map((s) => String(s).toLowerCase()),
  ];

  const has = (needleArr = []) =>
    (needleArr || []).some((tok) => hay.some((h) => h.includes(String(tok).toLowerCase())));

  if (has(prefs.preferMeats)) boost += 0.08;
  if (has(prefs.tagsUp)) boost += 0.06;
  if (has(prefs.avoid)) boost -= 0.12;
  if (has(prefs.tagsDown)) boost -= 0.06;

  // Nudge toward garden harvest usage if tags include "garden-harvest"
  if (has(["garden-harvest", "in-season"])) boost += 0.05;

  return boost;
}

/* ----------------------------- Macro Extraction ---------------------------- */

function extractRecipeMacros(recipe) {
  // Expecting recipe.macros maybe in { protein, fat, carbs } grams OR per serving.
  // Fallback: try nutrition.nutrients patterns if present.
  const m = recipe?.macros || recipe?.nutrition || null;
  if (!m) return { protein: 0, fat: 0, carbs: 0, kcal: 0 };

  const protein = Number(m.protein ?? m.Protein ?? 0);
  const fat = Number(m.fat ?? m.Fat ?? 0);
  const carbs = Number(m.carbs ?? m.Carbs ?? 0);
  const kcal = Number(m.kcal ?? m.calories ?? kcalFromMacros({ protein, fat, carbs }));

  return { protein, fat, carbs, kcal };
}

/* ----------------------------- Scoring Function ---------------------------- */

function scoreRecipeForSlot(recipe, perMealTargetG, prefs) {
  // Higher is better
  const m = extractRecipeMacros(recipe);
  const macroSim = cosineLike(m, perMealTargetG); // 0..1
  const kcalPenalty = Math.abs((m.kcal || 0) - (perMealTargetG.kcal || 0)) / Math.max(1, perMealTargetG.kcal || 1);
  const rulesOk = isTorahAllowed(recipe) ? 0 : -1; // hard drop if not allowed
  const prefBonus = preferenceBoost(recipe, prefs);

  if (rulesOk < 0) return -999;

  // Weighted sum: macro similarity primary, kcal tightness secondary, prefs tertiary
  return 0.75 * macroSim - 0.15 * Math.min(kcalPenalty, 1.5) + prefBonus;
}

/* ----------------------------- Bin-Packing Core ---------------------------- */

function greedyPack(recipes, perMealTargetG, days = DEFAULT_DAYS, mealsPerDay = DEFAULT_MEALS_PER_DAY, prefs = {}) {
  // Avoid repeats too often: track recent picks
  const usedCounts = new Map();
  const plan = [];

  const all = [...recipes];

  for (let d = 0; d < days; d++) {
    const day = { id: uid(), index: d, meals: [] };
    for (let m = 0; m < mealsPerDay; m++) {
      // score all recipes
      const scored = all
        .map((r) => {
          const s = scoreRecipeForSlot(r, perMealTargetG, prefs);
          // small penalty for frequent reuse
          const used = usedCounts.get(r.id) || 0;
          const reusePenalty = Math.min(used * 0.06, 0.3);
          return { r, score: s - reusePenalty };
        })
        .sort((a, b) => b.score - a.score);

      const pick = scored.find((s) => s.score > -0.2)?.r || scored[0]?.r || null;
      if (pick) {
        day.meals.push({
          mealIndex: m,
          recipeId: pick.id,
          title: pick.title,
          macros: extractRecipeMacros(pick),
        });
        usedCounts.set(pick.id, (usedCounts.get(pick.id) || 0) + 1);
      } else {
        day.meals.push({
          mealIndex: m,
          recipeId: null,
          title: "TBD",
          macros: { protein: 0, fat: 0, carbs: 0, kcal: 0 },
        });
      }
    }
    plan.push(day);
  }
  return plan;
}

/* ------------------------------ Grocery Diff ------------------------------- */

// naive ingredient parsing -> {name, qty, unit}
function parseIngredientRow(row) {
  if (!row) return { name: "", qty: 1, unit: "" };
  const s = String(row).trim();
  const match = s.match(/^(\d+(\.\d+)?)\s*([a-zA-Z]+)?\s+(.*)$/); // e.g., "2 tbsp olive oil"
  if (match) {
    return {
      qty: Number(match[1]),
      unit: (match[3] || "").toLowerCase(),
      name: (match[4] || "").toLowerCase(),
    };
  }
  return { name: s.toLowerCase(), qty: 1, unit: "" };
}

function aggregateRecipeIngredients(recipe) {
  const items = (recipe?.ingredients || []).map(parseIngredientRow);
  const agg = new Map();
  for (const it of items) {
    const key = `${it.name}__${it.unit}`;
    const prev = agg.get(key) || { name: it.name, unit: it.unit, qty: 0 };
    prev.qty += Number(it.qty) || 0;
    agg.set(key, prev);
  }
  return [...agg.values()];
}

function sumPlanIngredients(plan, recipeIndexById) {
  const totals = new Map();
  for (const day of plan || []) {
    for (const slot of day.meals || []) {
      const rec = recipeIndexById.get(slot.recipeId);
      if (!rec) continue;
      const rows = aggregateRecipeIngredients(rec);
      for (const r of rows) {
        const k = `${r.name}__${r.unit}`;
        const prev = totals.get(k) || { name: r.name, unit: r.unit, qty: 0 };
        prev.qty += r.qty;
        totals.set(k, prev);
      }
    }
  }
  return [...totals.values()];
}

function inventoryDiff(need, inventoryItems = []) {
  const invIdx = new Map();
  for (const it of inventoryItems) {
    const key = `${String(it.name || "").toLowerCase()}__${String(it.unit || "").toLowerCase()}`;
    invIdx.set(key, Number(it.qty || it.quantity || 0));
  }
  const out = [];
  for (const n of need) {
    const key = `${n.name}__${n.unit}`;
    const have = invIdx.get(key) || 0;
    const short = Math.max(0, (Number(n.qty) || 0) - have);
    if (short > 0) out.push({ name: n.name, unit: n.unit, qty: short });
  }
  return out;
}

/* ------------------------------- Public API -------------------------------- */

/**
 * computePerMealTargets(macroPlan):
 * Accepts MacroPercentCalculator-like payloads or {calories, macrosPct/macrosG, mealsPerDay}
 */
export function computePerMealTargets(macroPlan) {
  // normalize
  const calories = macroPlan?.targets?.calories ?? macroPlan?.calories ?? 2000;
  const mealsPerDay = macroPlan?.targets?.mealsPerDay ?? macroPlan?.mealsPerDay ?? DEFAULT_MEALS_PER_DAY;

  let grams = macroPlan?.targets?.macrosG ?? macroPlan?.macrosG ?? null;
  if (!grams) {
    const pct = macroPlan?.targets?.macrosPct ?? macroPlan?.macrosPct ?? { protein: 30, fat: 30, carbs: 40 };
    grams = {
      protein: (pct.protein / 100) * calories / 4,
      fat: (pct.fat / 100) * calories / 9,
      carbs: (pct.carbs / 100) * calories / 4,
    };
  }
  const perMeal = splitPerMeal(grams, mealsPerDay);
  return { perMeal, calories, mealsPerDay, gramsDaily: grams };
}

/**
 * buildMealPlanMap({ recipes, macroPlan, days, prefs })
 * Returns: { id, days, mealsPerDay, perMealTargets, schedule[], totals, grocery, context }
 */
export function buildMealPlanMap({ recipes = [], macroPlan = null, days = DEFAULT_DAYS, prefs = {} }) {
  const { perMeal, mealsPerDay, gramsDaily, calories } = computePerMealTargets(macroPlan);

  // index by id for quick lookup
  const recipeIndexById = new Map();
  for (const r of recipes) recipeIndexById.set(r.id, r);

  const schedule = greedyPack(recipes, perMeal, days, mealsPerDay, prefs);

  // totals
  const totals = {
    protein: 0,
    fat: 0,
    carbs: 0,
    kcal: 0,
  };
  for (const day of schedule) {
    for (const slot of day.meals) {
      totals.protein += slot.macros.protein || 0;
      totals.fat += slot.macros.fat || 0;
      totals.carbs += slot.macros.carbs || 0;
      totals.kcal += slot.macros.kcal || 0;
    }
  }

  // grocery diff
  const need = sumPlanIngredients(schedule, recipeIndexById);

  return {
    id: `mealplan_${uid()}`,
    days,
    mealsPerDay,
    perMealTargets: perMeal,
    dailyTargets: gramsDaily,
    targetCalories: calories,
    schedule, // [{index, meals:[{mealIndex, recipeId, title, macros}]}]
    totals: {
      protein: round0(totals.protein),
      fat: round0(totals.fat),
      carbs: round0(totals.carbs),
      kcal: round0(totals.kcal),
    },
    grocery: {
      need, // aggregated from plan (pre-inventory)
      missing: need, // placeholder until inventory is injected
    },
    context: {
      source: "MealPlanMapService",
      createdAt: new Date().toISOString(),
    },
  };
}

/**
 * diffPlanAgainstInventory(plan, inventoryItems)
 * mutates/returns plan with grocery.missing calculated.
 */
export function diffPlanAgainstInventory(plan, inventoryItems = []) {
  const missing = inventoryDiff(plan.grocery?.need || [], inventoryItems);
  plan.grocery = { ...(plan.grocery || {}), missing };
  return plan;
}

/* -------------------------- Store/Agent Integrations ----------------------- */

async function safeGetRecipes() {
  try {
    const mod = await import("@/store/RecipeStore");
    const useStore = mod.default || mod.useRecipeStore || null;
    const st = typeof useStore === "function" ? (useStore.getState ? useStore.getState() : useStore()) : null;
    return st?.recipes || [];
  } catch {
    return [];
  }
}

async function safeGetInventory() {
  try {
    const mod = await import("@/store/InventoryStore");
    const useStore = mod.default || mod.useInventoryStore || null;
    const st = typeof useStore === "function" ? (useStore.getState ? useStore.getState() : useStore()) : null;
    return st?.items || st?.inventory || [];
  } catch {
    return [];
  }
}

async function safeGetPrefs() {
  try {
    const mod = await import("@/store/MealPrefsStore");
    const useStore = mod.default || mod.useMealPrefsStore || null;
    const st = typeof useStore === "function" ? (useStore.getState ? useStore.getState() : useStore()) : null;
    // Example structure; adjust to your actual store
    return st?.prefs || {
      preferMeats: ["lamb", "beef", "goat"],
      avoid: [],
      tagsUp: ["hair-growth", "in-season", "garden-harvest"],
      tagsDown: [],
    };
  } catch {
    return {
      preferMeats: ["lamb", "beef", "goat"],
      avoid: [],
      tagsUp: ["hair-growth", "in-season", "garden-harvest"],
      tagsDown: [],
    };
  }
}

/**
 * buildFromContext(macroPlan, days?): Pulls recipes, inventory, prefs dynamically if available.
 */
export async function buildFromContext(macroPlan, days = DEFAULT_DAYS) {
  const [recipes, inventory, prefs] = await Promise.all([safeGetRecipes(), safeGetInventory(), safeGetPrefs()]);
  let plan = buildMealPlanMap({ recipes, macroPlan, days, prefs });
  plan = diffPlanAgainstInventory(plan, inventory);
  return { plan, recipes, inventory, prefs };
}

/* --------------------------- Event Orchestration --------------------------- */

function dispatch(name, detail) {
  try {
    window.dispatchEvent(new CustomEvent(name, { detail }));
  } catch {}
}

function persist(plan, ctx) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ plan, ctx }));
  } catch {}
}

/**
 * listenAndAutoPlan(): Attaches event listeners so that when a macro plan arrives
 * or recipes update, we autogenerate a visible plan and notify the app.
 */
export function listenAndAutoPlan() {
  // Debounce to avoid thrash if many events fire together.
  let timer = null;
  let lastMacroPlan = null;

  const fireBuild = async () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      if (!lastMacroPlan) return;
      const { plan, recipes, inventory, prefs } = await buildFromContext(lastMacroPlan, DEFAULT_DAYS);
      persist(plan, { recipesCount: recipes.length });
      dispatch("suka:mealPlanGenerated", { plan, recipesCount: recipes.length, inventoryCount: inventory.length, prefs });
    }, 80);
  };

  function onMacroPlan(e) {
    lastMacroPlan = e?.detail?.plan || e?.detail || null;
    fireBuild();
  }

  function onRecipesImported() {
    fireBuild();
  }

  function onGroceryMerge() {
    // Optional: could rebuild grocery diff; here we just notify the UI to refresh grocery view.
    dispatch("suka:mealPlanNeedsGroceryRefresh", {});
  }

  // Attach
  window.addEventListener("suka:macroPlanApplied", onMacroPlan);
  window.addEventListener("suka:recipesImported", onRecipesImported);
  window.addEventListener("suka:groceryListMerge", onGroceryMerge);

  // Also: try to bootstrap from last saved macro plan if present in ImportBridge or MacroCalc storage.
  try {
    const importRaw = localStorage.getItem("nutritionImportBridge:v1");
    const macroRaw = localStorage.getItem("macroCalc:v1");
    const imp = importRaw ? JSON.parse(importRaw) : null;
    const mac = macroRaw ? JSON.parse(macroRaw) : null;
    const boot =
      imp?.macroPlan ||
      (mac
        ? {
            calories: mac.calories,
            mealsPerDay: mac.meals,
            macrosG: null,
            macrosPct: { protein: mac.proteinPct, fat: mac.fatPct, carbs: mac.carbPct },
          }
        : null);
    if (boot) {
      lastMacroPlan = boot;
      fireBuild();
    }
  } catch {
    // ignore
  }

  // Return unsubscribe to allow teardown on route change
  return () => {
    window.removeEventListener("suka:macroPlanApplied", onMacroPlan);
    window.removeEventListener("suka:recipesImported", onRecipesImported);
    window.removeEventListener("suka:groceryListMerge", onGroceryMerge);
  };
}

/* --------------------------- Batch Cooking Hooks --------------------------- */

/**
 * suggestBatchCandidates(plan, minRepeats = 2):
 * Find recipes that appear multiple times – good for batch sessions.
 */
export function suggestBatchCandidates(plan, minRepeats = 2) {
  const count = new Map();
  for (const day of plan?.schedule || []) {
    for (const m of day.meals || []) {
      if (!m.recipeId) continue;
      count.set(m.recipeId, (count.get(m.recipeId) || 0) + 1);
    }
  }
  return [...count.entries()]
    .filter(([, n]) => n >= minRepeats)
    .map(([recipeId, n]) => ({ recipeId, occurrences: n }));
}

/**
 * dispatchBatchQueue(plan): convenience to push suggested batch recipes.
 */
export function dispatchBatchQueue(plan) {
  const picks = suggestBatchCandidates(plan, 2);
  if (!picks.length) return;
  dispatch("suka:batchQueueAdd", { recipeIds: picks.map((p) => p.recipeId) });
}

/* ------------------------------- Garden Nudge ------------------------------ */

/**
 * gardenNudge(plan, recipes, seasonTags = ["in-season","garden-harvest"]):
 * Adds a soft score to promote in-season harvest recipes during rebuilds.
 */
export function gardenNudge(plan, recipes, seasonTags = ["in-season", "garden-harvest"]) {
  // This is a placeholder for tighter integration with your Garden module.
  // Could re-score and swap lowest-scoring slots for in-season options.
  const tagSet = new Set(seasonTags.map((t) => String(t).toLowerCase()));
  const seasonal = recipes.filter((r) =>
    (r.tags || []).some((t) => tagSet.has(String(t).toLowerCase()))
  );
  return { seasonalCount: seasonal.length, note: "Seasonal recipes identified for potential swap." };
}

/* --------------------------------- Helpers -------------------------------- */

/**
 * reviveFromCache(): returns last computed plan if available
 */
export function reviveFromCache() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    return obj?.plan || null;
  } catch {
    return null;
  }
}

/**
 * toPrintable(plan): small reducer for printing/exporting
 */
export function toPrintable(plan) {
  const out = [];
  for (const day of plan?.schedule || []) {
    out.push({ day: day.index + 1, meals: day.meals.map((m) => ({ title: m.title || "TBD" })) });
  }
  return out;
}

/* --------------------------------- Example -------------------------------- */
/**
 * Example usage in a React effect:
 *
 * useEffect(() => {
 *   const off = listenAndAutoPlan();
 *   return () => off();
 * }, []);
 *
 * // Also listen for the emitted plan:
 * useEffect(() => {
 *   function onPlan(e){ setMealPlan(e.detail.plan) }
 *   window.addEventListener("suka:mealPlanGenerated", onPlan);
 *   return () => window.removeEventListener("suka:mealPlanGenerated", onPlan);
 * }, []);
 */
