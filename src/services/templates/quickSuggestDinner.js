// src/services/templates/quickSuggestDinner.js

import * as RecipeStore from "@/store/RecipeStore";
import * as MealPlanStore from "@/store/MealPlanStore";
import generateCookingSession from "@/services/planning/generateCookingSession";
import * as inventoryUtils from "@/utils/inventoryUtils";
import * as toolUtils from "@/utils/toolUtils";
import * as timeUtils from "@/utils/timeUtils";

// Optional/guarded modules for richer UX (all best-effort)
let NotificationCenter, CalendarSyncModule, BadgeManager;
try { NotificationCenter = require("@/managers/NotificationCenter").default; } catch (_) {}
try { CalendarSyncModule = require("@/services/calendar/CalendarSyncModule").default; } catch (_) {}
try { BadgeManager = require("@/managers/BadgeManager"); } catch (_) {}

/**
 * Template object (contract-compliant)
 */
export const template = {
  id: "quick_suggest_dinner_v1",
  version: "1.2.0",
  purpose: "Remove the 'what should we eat?' tax with 1–3 smart dinner picks.",
  triggers: ["time::17:00_local", "ui::MealPlannerDashboard.open", "voice::what's for dinner"],
  inputs: {
    required: ["profile", "inventorySnapshot"],
    optional: ["timeAvailable", "tools", "donenessPrefs"]
  },
  logic: {
    selectors: [
      "RecipeStore.getAll()",
      "inventoryUtils.missingIngredients()",
      "inventoryUtils.suggestSwaps?(ingredient, snapshot)",
      "toolUtils.matchUserTools()",
      "MealPlanStore.getRecent?() to avoid repeats"
    ],
    rules: [
      "Filter recipes by diet & allergies.",
      "Filter by available tools; allow soft-compat when a substitute exists.",
      "Score by: inventory fit, time fit vs. timeAvailable, expected leftover value, cost/effort & cuisine variety.",
      "Ensure at least one < 35 minutes; prefer < 25 when time is tight.",
      "Return 1–3 picks and a tiny 0–2 item add-on list using pantry swaps where possible."
    ],
    llm_roles: []
  },
  actions: [
    "dispatch:generateCookingSession with 1–3 picks",
    "write:MealPlanStore.addQuickPlan(day=today)",
    "open:CookingSessionPlanner.jsx with chosen recipe",
    "notify:minimal 'Dinner solved' ping; optional calendar block"
  ],
  outputs: {
    ui: ["CookingSessionPlanner.jsx"],
    data: ["sessionPlan", "timers", "shoppingGaps"],
    alerts: []
  },
  fallbacks: [
    "If inventory is thin → suggest 2-item grocery add-on or a pantry pasta."
  ],
  success_message: "Dinner solved. I queued a quick session and opened the planner.",
  used_by: ["mealPlanningAgent", "cookingAgent"]
};

/* ---------------- helpers ---------------- */

const toNum = (n, fb = 0) => (Number.isFinite(Number(n)) ? Number(n) : fb);

function normalizeTags(arr = []) {
  return (arr || []).map((t) => String(t || "").toLowerCase());
}

function respectsDietAndAllergies(recipe, profile = {}) {
  const diet = String(profile?.diet || "").toLowerCase();
  const allergies = normalizeTags(profile?.allergies || profile?.intolerances || []);
  const tags = normalizeTags(recipe.diets || recipe.tags || []);

  // Diet
  if (diet) {
    const okDiet =
      tags.includes(diet) ||
      (diet === "omnivore" && !tags.includes("vegan-only"));
    if (!okDiet) return false;
  }

  // Allergies/intolerances (simple name check across ingredients)
  if (allergies.length) {
    const ings = (recipe.ingredients || []).map((i) =>
      (typeof i === "string" ? i : i?.name || "").toLowerCase()
    );
    if (ings.some((ing) => allergies.some((a) => ing.includes(a)))) return false;
  }

  return true;
}

function toolOk(recipe, toolsNow = []) {
  const res = toolUtils.matchUserTools?.(recipe, toolsNow);
  return res?.ok ?? true; // default permissive if tool matcher not present
}

function leftoverValue(recipe, householdSize = 2) {
  return Math.max((recipe.servings || householdSize) - householdSize, 0);
}

function timeFit(recipe, timeAvailable = 40) {
  const t = toNum(recipe.totalTime ?? recipe.activeTime ?? 30, 30);
  const diff = Math.abs(t - timeAvailable);
  return Math.max(0, 1 - Math.min(diff, 60) / 60); // 1 = perfect
}

function effort(recipe) {
  // crude effort proxy: activeTime or steps count
  const active = toNum(recipe.activeTime ?? recipe.totalTime ?? 30, 30);
  const steps = Array.isArray(recipe.steps) ? recipe.steps.length : 6;
  // Normalize so lower = better; invert to 0..1 where 1 is easier
  const e = (active / 60) * 0.6 + (steps / 12) * 0.4;
  return Math.max(0, 1 - Math.min(e, 1)); // 1 = low effort
}

function costFit(recipe, snapshot) {
  // If you have a real cost model, wire it here. Otherwise approximate:
  // more inventory coverage → lower incremental cost.
  const missing = inventoryUtils.missingIngredients?.(recipe, snapshot) || [];
  const need = (recipe.ingredients || []).length || 1;
  const inv = Math.max(0, 1 - missing.length / need);
  return inv; // 1 = cheap tonight (we already own most)
}

function cuisineVarietyPenalty(recipe, recentRecipes = []) {
  // discourage offering the exact same cuisine repeatedly (light touch)
  const cuisine = (recipe.cuisine || recipe.region || "").toLowerCase();
  const recent = recentRecipes.slice(0, 6).map((r) => (r.cuisine || r.region || "").toLowerCase());
  if (!cuisine) return 0;
  const repeats = recent.filter((c) => c === cuisine).length;
  return Math.min(0.15, repeats * 0.05); // subtract up to 0.15
}

function dedupeById(arr, key = "id") {
  const seen = new Set();
  return arr.filter((x) => {
    const id = x?.[key] || x?.recipe?.[key] || x?.name;
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function ensureQuickFirst(picks, capMin) {
  const quickIdx = picks.findIndex((c) => toNum(c.recipe.totalTime ?? c.recipe.activeTime ?? 30, 30) <= capMin);
  if (quickIdx > 0) {
    const q = picks[quickIdx];
    picks.splice(quickIdx, 1);
    picks.unshift(q);
  }
  return picks;
}

/**
 * Build tiny shopping add-ons, preferring pantry swaps.
 * Returns [{ name, qty, unit, note }]
 */
function buildTinyAddOns(recipe, snapshot, limit = 2) {
  const missing = inventoryUtils.missingIngredients?.(recipe, snapshot) || [];
  if (!missing.length) return [];

  const addOns = [];
  for (const m of missing) {
    if (addOns.length >= limit) break;

    // Try swap
    const swap = inventoryUtils.suggestSwaps?.(m, snapshot) || null;
    if (swap?.onHandQty && swap.onHandQty >= (m.qty ?? 1) * 0.8) {
      addOns.push({
        name: m.name,
        qty: 0,
        unit: m.unit || "",
        note: `Swap with ${swap.name} on hand`
      });
      continue;
    }
    addOns.push({
      name: m.name,
      qty: m.qty ?? 1,
      unit: m.unit || "",
      note: ""
    });
  }

  // Only keep items that actually require purchasing
  const essentials = addOns.filter((a) => a.qty > 0);
  // Keep at most one “covered by swap” hint so the list stays tiny
  const advisory = addOns.find((a) => a.qty === 0);
  return advisory ? [...essentials, advisory] : essentials;
}

/* ---------------- execute ---------------- */

/**
 * Execute the template.
 * @param {Object} payload
 * @param {Object} payload.profile - user profile (expects .diet, .householdSize, .allergies?)
 * @param {Object} payload.inventorySnapshot - { items: {id->qty}, ... }
 * @param {number} [payload.timeAvailable] - minutes user can spend
 * @param {Array<string>} [payload.tools] - tools user has available now
 * @param {Object} [payload.donenessPrefs] - e.g. { vegCrunch: 'crisp', steak:'medium' }
 * @param {Object} [ctx] - optional runtime context
 * @param {Date} [ctx.now]
 * @param {Function} [ctx.openUI] - function(route, params) to open panels
 * @param {Function} [ctx.runTemplate] - to call doneness personalizer (optional)
 * @returns {Promise<{sessionId:string, picks:Array, shoppingGaps:Array, message:string}>}
 */
export async function execute(payload, ctx = {}) {
  const {
    profile,
    inventorySnapshot,
    timeAvailable = 40, // sensible default for a weeknight
    tools = [],
    donenessPrefs = {}
  } = payload;

  const { now = new Date(), openUI, runTemplate } = ctx;

  // 1) Gather candidates with guardrails
  const allRecipes = (RecipeStore.getAll?.() || []).filter((r) =>
    respectsDietAndAllergies(r, profile) && toolOk(r, tools)
  );

  const householdSize = toNum(profile?.householdSize ?? 2, 2);
  const recent = MealPlanStore.getRecent?.(7) || []; // last ~7 entries if available

  // 2) Score candidates
  const scored = allRecipes.map((r) => {
    const invFitMissing = inventoryUtils.missingIngredients?.(r, inventorySnapshot) || [];
    const need = (r.ingredients || []).length || 1;
    const inv = Math.max(0, 1 - invFitMissing.length / need);
    const tf = timeFit(r, timeAvailable);
    const lo = leftoverValue(r, householdSize);
    const eff = effort(r);
    const cost = costFit(r, inventorySnapshot);
    const varietyPenalty = cuisineVarietyPenalty(r, recent);

    // Weighted (inv-first, then time/effort/cost, then leftovers, minus variety penalty)
    const score = inv * 0.45 + tf * 0.2 + eff * 0.15 + cost * 0.1 + Math.min(lo, 3) * 0.08 - varietyPenalty;

    return { recipe: r, score, inv, tf, lo, eff, cost };
  });

  // Filter obviously bad fits and sort by score
  const candidates = scored
    .filter((c) => c.score > 0.2) // very rough floor
    .sort((a, b) => b.score - a.score);

  // Prefer one truly quick option first if time is tight
  const timeCap = timeAvailable <= 30 ? 25 : 35;
  let picks = candidates.slice(0, 6);
  picks = ensureQuickFirst(picks, timeCap).slice(0, 3);
  picks = dedupeById(picks, "recipe");

  // 3) Thin inventory fallback
  const thinInventory = picks.length === 0 || picks.every((p) => p.inv < 0.5);
  let shoppingGaps = [];

  if (thinInventory) {
    // Pick the candidate with the smallest missing set among top 12
    const best =
      scored
        .slice(0, 12)
        .map((c) => ({
          ...c,
          missing: inventoryUtils.missingIngredients?.(c.recipe, inventorySnapshot) || []
        }))
        .sort((a, b) => a.missing.length - b.missing.length)[0] || null;

    if (best && best.missing?.length) {
      shoppingGaps = buildTinyAddOns(best.recipe, inventorySnapshot, 2);
      picks = [best];
    } else {
      // Pantry pasta stub (no shopping)
      const pantryPasta = {
        id: "pantry_pasta_15m",
        name: "Pantry Pasta (Garlic & Oil)",
        servings: householdSize,
        totalTime: 15,
        ingredients: ["dry pasta", "olive oil", "garlic", "salt"],
        steps: [
          "Boil pasta until al dente.",
          "Warm oil with sliced garlic until fragrant (do not brown).",
          "Toss pasta with oil; salt to taste. Add chili flakes if you like."
        ],
        tags: ["quick", "pantry"]
      };
      picks = [{ recipe: pantryPasta, score: 0.5, inv: 1, tf: 1, lo: 0 }];
      shoppingGaps = [];
    }
  } else {
    // Build minimal add-on list for the first pick only (keeps attention tight)
    shoppingGaps = buildTinyAddOns(picks[0].recipe, inventorySnapshot, 2);
  }

  // 4) Build the session (1–3 picks)
  const selectedRecipes = picks.map((p) => p.recipe);

  const session = await generateCookingSession({
    recipes: selectedRecipes,
    donenessPrefs,
    tools,
    timeCap: timeAvailable,
    context: { mode: "quick-suggest" }
  });

  // Optional: pre-tune doneness & sensory cues for the first pick
  try {
    if (runTemplate && selectedRecipes[0]?.id) {
      await runTemplate("doneness_texture_personalizer_v1", {
        recipeId: selectedRecipes[0].id,
        donenessPrefs,
        stoveHeatBias: profile?.appliances?.stoveHeatBias
      });
    }
  } catch (_) {}

  // 5) Add a quick plan entry for today (best-effort)
  const today = timeUtils?.toLocalISODate?.(now) || new Date(now).toISOString().slice(0, 10);
  MealPlanStore.addQuickPlan?.({
    day: today,
    recipeIds: selectedRecipes.map((r) => r.id || r.name),
    sessionId: session?.id
  });

  // 6) Open the Cooking Session Planner
  if (typeof openUI === "function") {
    openUI("CookingSessionPlanner", { sessionId: session?.id, picks: selectedRecipes, shoppingGaps });
  } else {
    window.dispatchEvent(
      new CustomEvent("ui:navigate", {
        detail: { route: "CookingSessionPlanner", params: { sessionId: session?.id, picks: selectedRecipes, shoppingGaps } }
      })
    );
  }

  // 7) Friendly ping + optional calendar block (best-effort)
  NotificationCenter?.notify?.({
    title: "Dinner solved",
    message: selectedRecipes[0]?.name ? `Queued ${selectedRecipes[0].name}.` : "Queued a quick session.",
    action: "Open"
  });

  // If your calendar supports lightweight blocks, add a soft dinner block for tonight
  try {
    const start = new Date(now);
    start.setHours(Math.max(17, start.getHours()), 0, 0, 0);
    const minutes = Math.max(20, toNum(selectedRecipes[0]?.totalTime ?? timeAvailable, timeAvailable));
    const end = timeUtils?.addMinutes?.(start, minutes) || new Date(start.getTime() + minutes * 60000);
    CalendarSyncModule?.load?.([{ start, end, title: "Quick Dinner", tags: ["meal"] }]);
  } catch (_) {}

  // 8) Tiny streak/badge nudge (best-effort)
  try { BadgeManager?.increment?.("quick_dinner"); } catch (_) {}

  return {
    sessionId: session?.id,
    picks: selectedRecipes,
    shoppingGaps,
    message: template.success_message
  };
}

/**
 * Default export for TemplateRunner compatibility
 */
export default { template, execute };
