// src/services/templates/fridgeZeroWasteSweep.js

import * as timeUtils from "@/utils/timeUtils";
import * as inventoryUtils from "@/utils/inventoryUtils";

// Optional/guarded modules (rename if your app differs)
let MealPlanStore, GroceryListStore, NotificationCenter, SettingsStore, CalendarSyncModule;
try { MealPlanStore = require("@/store/MealPlanStore"); } catch (_) {}
try { GroceryListStore = require("@/store/GroceryListStore"); } catch (_) {}
try { NotificationCenter = require("@/managers/NotificationCenter").default; } catch (_) {}
try { SettingsStore = require("@/store/SettingsStore"); } catch (_) {}
try { CalendarSyncModule = require("@/services/calendar/CalendarSyncModule").default; } catch (_) {}

const isoDate = (d = new Date()) =>
  (typeof timeUtils?.toLocalISODate === "function")
    ? timeUtils.toLocalISODate(d)
    : new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, Number(n) || 0));

/**
 * Contract-compliant metadata
 */
export const template = {
  id: "fridge_zero_waste_sweep_v2",
  version: "2.4.0",
  purpose: "Use it up first—smart, tasty, diet-aware, and low-effort.",
  // Default weekly sweep Friday 5pm local + dynamic nudges
  triggers: ["RRULE:FREQ=WEEKLY;BYDAY=FR;BYHOUR=17;BYMINUTE=0;BYSECOND=0", "ui::inventory.sweep"],
  inputs: {
    /**
     * expiring: [{ name, qty, unit, daysLeft?, type?('veg'|'protein'|'starch'|'dairy'|'fruit'|'aromatic'), note?, dietTags?[] }]
     * leftovers: [{ name, qty, unit, flavor? ('italian'|'mexican'|'asian'|'indian'|...), type?, dietTags?[] }]
     * pantrySnapshot?: { items: { name->qty or {qty, unit} } }  // optional (else inventoryUtils snapshot)
     * diet?: { vegetarian?:boolean, vegan?:boolean, dairyFree?:boolean, glutenFree?:boolean, allergens?:string[] }
     * household?: { size?:number }  // affects servings
     */
    required: ["expiring", "leftovers"],
    optional: ["pantrySnapshot", "diet", "household"]
  },
  logic: {
    selectors: [
      "inventoryUtils.getSnapshot() for pantry when not provided",
      "Classify items (veg/protein/starch/dairy/fruit/aromatic)",
      "Urgency scoring by daysLeft & mass",
      "Compose 2–3 plans (soup | stir-fry | egg-bake | fried-rice | quesadillas) diet-aware",
      "Auto-draft Saturday brunch with top plan; show visible draft"
    ],
    rules: [
      "Maximize urgent-mass use first; prefer plans that consume most at-risk items.",
      "Balance with pantry staples only if available (no new shopping).",
      "Respect diet and allergens; auto-swap where possible.",
      "Delete overlapping grocery list items that we’ll use now."
    ],
    llm_roles: []
  },
  actions: [
    "OPEN_UI",              // Plan preview (visible draft)
    "PATCH_MEALPLAN",       // Apply top pick to Saturday
    "GROCERY_DELETE",       // Remove consumed items
    "NOTIFY",               // Heads-up
    "CALENDAR_SYNC"         // Optional log event
  ],
  outputs: {
    ui: [],
    data: ["zeroWasteList", "simpleRecipes", "draft", "scores"],
    alerts: []
  },
  fallbacks: [
    "If nothing feasible → trigger Preservation—Freezing (#7) for overflow portions."
  ],
  success_message: "Zero-waste draft ready. Top pick added to Saturday brunch.",
  used_by: ["inventoryAgent", "mealPlanningAgent"]
};

/* ---------------- Helpers ---------------- */

const toStr = (v) => String(v ?? "").toLowerCase();

function classify(item = {}) {
  const n = toStr(item.name);
  const t = toStr(item.type);
  if (/(chicken|beef|pork|turkey|tofu|tempeh|fish|shrimp|egg)/.test(n) || /(protein|meat)/.test(t)) return "protein";
  if (/(rice|noodle|pasta|potato|tortilla|bread|grain|couscous|quinoa)/.test(n) || /starch/.test(t)) return "starch";
  if (/(milk|cream|cheese|yogurt|ricotta|mozzarella)/.test(n) || /dairy/.test(t)) return "dairy";
  if (/(onion|garlic|leek|shallot|ginger|scallion)/.test(n) || /aromatic/.test(t)) return "aromatic";
  if (/(apple|pear|berry|orange|banana|fruit)/.test(n) || /fruit/.test(t)) return "fruit";
  return "veg";
}

function bucketize(items = []) {
  const b = { veg: [], protein: [], starch: [], dairy: [], aromatic: [], fruit: [] };
  items.forEach((it) => (b[classify(it)] || (b.veg)).push(it));
  return b;
}

function sumQty(arr) { return arr.reduce((s, a) => s + Number(a.qty ?? 0), 0); }

function urgencyScore(item) {
  // Lower daysLeft = higher urgency; weight by quantity
  const dl = Number.isFinite(Number(item.daysLeft)) ? Number(item.daysLeft) : 7;
  const qty = Number(item.qty ?? 1);
  const base = 10 / Math.max(1, dl); // 10 for today, ~1.6 for 6d, etc.
  // Bump for proteins & dairy (spoil faster)
  const cat = classify(item);
  const catBoost = (cat === "protein" ? 1.5 : cat === "dairy" ? 1.25 : 1.0);
  return base * qty * catBoost;
}

function flavorHint(leftovers = []) {
  const tags = leftovers.map((l) => toStr(l.flavor));
  if (tags.some((t) => /asian|soy|ginger|sesame|gochujang/.test(t))) return "asian";
  if (tags.some((t) => /mex|taco|chipotle|salsa|adobo/.test(t))) return "mexican";
  if (tags.some((t) => /indian|garam|masala|curry|tikka/.test(t))) return "indian";
  if (tags.some((t) => /italian|basil|oregano|tomato/.test(t))) return "italian";
  return "neutral";
}

function hasPantry(pantry, names = []) {
  const snap = pantry?.items ? pantry.items : pantry;
  const keys = new Set(Object.keys(snap || {}).map((k) => toStr(k)));
  return names.some((n) => keys.has(toStr(n)));
}

function servesFor(household) {
  const sz = clamp(Number(household?.size ?? 3), 1, 8);
  // default recipe serves ~ household size
  return sz;
}

/* ---- Diet & swaps ---- */

function dietAllows(diet = {}, item = {}) {
  const name = toStr(item.name);
  if (diet.vegan) {
    if (/(egg|cheese|milk|yogurt|cream|butter)/.test(name)) return false;
    if (/(beef|pork|chicken|fish|shrimp)/.test(name)) return false;
  } else if (diet.vegetarian) {
    if (/(beef|pork|chicken|fish|shrimp)/.test(name)) return false;
  }
  if (diet.dairyFree && /(cheese|milk|cream|yogurt|ricotta|mozzarella|butter)/.test(name)) return false;
  if (diet.glutenFree && /(pasta|noodle|tortilla|bread)/.test(name)) return false;
  if (Array.isArray(diet.allergens) && diet.allergens.length) {
    const hit = diet.allergens.some(a => name.includes(toStr(a)));
    if (hit) return false;
  }
  return true;
}

function swapForDiet(name, diet = {}) {
  const n = toStr(name);
  if (diet.vegan || diet.vegetarian) {
    if (/(chicken|beef|pork|turkey)/.test(n)) return "chickpeas";
    if (/(fish|shrimp)/.test(n)) return "tofu";
  }
  if (diet.dairyFree && /(cheese|yogurt|cream)/.test(n)) return "olive oil + herbs";
  if (diet.glutenFree && /(pasta|noodle|tortilla|bread)/.test(n)) return "rice";
  return name;
}

/* ---- Builders (diet/pantry aware) ---- */

function buildSoup(expiring, leftovers, pantry, diet, household) {
  const b = bucketize([...expiring, ...leftovers]);
  const uses = [];
  const veg = b.veg.filter(i => dietAllows(diet, i)).slice(0, 4); veg.forEach(v => uses.push(v));
  const prot = (b.protein.find(p => dietAllows(diet, p)) || null);
  if (prot) uses.push(prot);
  const starch = b.starch.find(s => /rice|noodle|pasta|potato|tortilla/.test(toStr(s.name)));
  if (starch && dietAllows(diet, starch)) uses.push(starch);

  // ensure pantry has stock/water substitute
  const stockOk = hasPantry(pantry, ["stock", "broth"]) || true; // water acceptable
  const servings = servesFor(household);
  const usedMass = sumQty(uses);
  const ingredients = [
    ...veg.map(v => v.name),
    prot ? swapForDiet(prot.name, diet) : null,
    starch ? swapForDiet(starch.name, diet) : null,
    stockOk ? "stock or water" : "water",
    "salt", "pepper"
  ].filter(Boolean);

  const recipe = {
    id: "zw_soup_friday",
    name: "Friday Fridge-Clear Soup",
    totalTime: 25,
    servings,
    ingredients,
    steps: [
      "Dice veg; slice any protein small.",
      "Sweat aromatics/veg with oil and a pinch of salt (3–5 min).",
      "Add stock/water; simmer 8–10 min until veg tender.",
      prot ? "Stir in chopped protein (or canned beans) to warm through." : "Adjust seasoning to taste.",
      starch ? "Add cooked starch at the end so it doesn't bloat." : "Optionally add a handful of greens.",
      "Finish with lemon/vinegar or herbs if you have them."
    ],
    tags: ["zero_waste", "soup", "quick", ...(diet.vegan ? ["vegan"] : diet.vegetarian ? ["vegetarian"] : [])]
  };
  return { recipe, usedMass, uses };
}

function buildStirFry(expiring, leftovers, pantry, diet, household) {
  const b = bucketize([...expiring, ...leftovers]);
  const uses = [];
  const veg = b.veg.filter(i => dietAllows(diet, i)).slice(0, 3); veg.forEach((v) => uses.push(v));
  const prot = b.protein.find(p => dietAllows(diet, p));
  if (prot) uses.push(prot);
  const starch = b.starch.find(s => /rice|noodle/.test(toStr(s.name)));
  if (starch && dietAllows(diet, starch)) uses.push(starch);

  const flv = flavorHint(leftovers);
  const sauce =
    flv === "asian" ? "soy + vinegar + sesame" :
    flv === "mexican" ? "lime + cumin + chili" :
    flv === "indian" ? "garam masala + yogurt (or DF alt)" :
    flv === "italian" ? "garlic + olive oil + herbs" :
    "soy or salt + splash of acid";
  const servings = servesFor(household);
  const usedMass = sumQty(uses);

  const recipe = {
    id: "zw_stirfry_friday",
    name: "Friday “Use-It” Stir-Fry",
    totalTime: 15,
    servings,
    ingredients: [
      ...veg.map(v => v.name),
      prot ? swapForDiet(prot.name, diet) : null,
      starch ? swapForDiet(starch.name, diet) : null,
      sauce
    ].filter(Boolean),
    steps: [
      "Cut everything bite-size. Preheat pan until hot.",
      "Stir-fry veg 3–4 min (keep crisp).",
      prot ? "Add protein (or nuts/beans) to heat through." : "Add a handful of nuts or beans if available.",
      "Toss with sauce; add cooked rice/noodles if using.",
      "Finish with scallions/herbs if you have them."
    ],
    tags: ["zero_waste", "stir_fry", "quick"]
  };
  return { recipe, usedMass, uses };
}

function buildEggBake(expiring, leftovers, pantry, diet, household) {
  if (diet.vegan) {
    // Skip egg bake for strict vegan; caller can still select other plans.
    return { recipe: { id: "skip_vegan_eggbake", name: "Skip (vegan)", totalTime: 0, servings: servesFor(household), ingredients: [], steps: [], tags: [] }, usedMass: 0, uses: [] };
  }
  const b = bucketize([...expiring, ...leftovers]);
  const uses = [];
  const veg = b.veg.filter(i => dietAllows(diet, i)).slice(0, 4); veg.forEach(v => uses.push(v));
  const dairy = b.dairy.find(d => dietAllows(diet, d));
  if (dairy) uses.push(dairy);
  const prot = b.protein.find(p => /ham|sausage|bacon|tofu|chicken/.test(toStr(p.name)) && dietAllows(diet, p));
  if (prot) uses.push(prot);

  const servings = servesFor(household) + 1; // brunch leftovers
  const usedMass = sumQty(uses);

  const recipe = {
    id: "zw_eggbake_sat",
    name: "Saturday Zero-Waste Egg Bake",
    totalTime: 25,
    servings,
    ingredients: [
      "6–10 eggs", ...veg.map(v => v.name),
      prot ? swapForDiet(prot.name, diet) : null,
      dairy ? swapForDiet(dairy.name, diet) : "cheese (optional)",
      "salt", "pepper", "oil"
    ].filter(Boolean),
    steps: [
      "Heat oven to 375°F/190°C. Oil a small pan.",
      "Sauté veg briefly with a pinch of salt.",
      "Whisk eggs; fold in veg (and protein/cheese).",
      "Bake 12–18 min until just set; center has slight wobble.",
      "Rest 5 min; slice and serve (or chill for brunch)."
    ],
    tags: ["zero_waste", "egg_bake", "brunch"]
  };
  return { recipe, usedMass, uses };
}

function buildFriedRice(expiring, leftovers, pantry, diet, household) {
  if (!hasPantry(pantry, ["rice"]) && !hasPantry(pantry, ["microwave rice", "ready rice"])) {
    return { recipe: { id: "skip_no_rice", name: "Skip (no rice)", totalTime: 0, servings: servesFor(household), ingredients: [], steps: [], tags: [] }, usedMass: 0, uses: [] };
  }
  const b = bucketize([...expiring, ...leftovers]);
  const uses = [];
  const veg = b.veg.filter(i => dietAllows(diet, i)).slice(0, 3); veg.forEach(v => uses.push(v));
  const eggs = diet.vegan ? null : { name: "eggs", qty: 3, unit: "pcs" };
  const prot = b.protein.find(p => dietAllows(diet, p));
  if (prot) uses.push(prot);

  const usedMass = sumQty(uses);
  const servings = servesFor(household);

  const recipe = {
    id: "zw_friedrice",
    name: "Zero-Waste Fried Rice",
    totalTime: 15,
    servings,
    ingredients: [
      "cooked rice",
      ...veg.map(v => v.name),
      prot ? swapForDiet(prot.name, diet) : null,
      eggs ? "eggs (optional)" : null,
      "soy or salt", "oil"
    ].filter(Boolean),
    steps: [
      "Heat pan with oil. Add veg; stir-fry 2–3 min.",
      prot ? "Add chopped protein to warm." : "Add nuts or seeds if available.",
      "Push to one side; add egg and scramble (skip if vegan).",
      "Add rice; toss with soy/salt. Finish with any scallions/herbs."
    ],
    tags: ["zero_waste", "stir_fry", "quick"]
  };
  return { recipe, usedMass, uses };
}

function buildQuesadillas(expiring, leftovers, pantry, diet, household) {
  if (diet.glutenFree) return { recipe: { id: "skip_gf_tortilla", name: "Skip (GF)", totalTime: 0, servings: servesFor(household), ingredients: [], steps: [], tags: [] }, usedMass: 0, uses: [] };
  if (!hasPantry(pantry, ["tortilla"]) && !hasPantry(pantry, ["tortillas"])) {
    return { recipe: { id: "skip_no_tortilla", name: "Skip (no tortillas)", totalTime: 0, servings: servesFor(household), ingredients: [], steps: [], tags: [] }, usedMass: 0, uses: [] };
  }
  const b = bucketize([...expiring, ...leftovers]);
  const uses = [];
  const veg = b.veg.filter(i => dietAllows(diet, i)).slice(0, 3); veg.forEach(v => uses.push(v));
  const dairy = diet.dairyFree ? null : (b.dairy[0] || { name: "cheese", qty: 1, unit: "cup" }); if (dairy) uses.push(dairy);
  const prot = b.protein.find(p => dietAllows(diet, p)); if (prot) uses.push(prot);

  const usedMass = sumQty(uses);
  const servings = servesFor(household);

  const recipe = {
    id: "zw_quesa",
    name: "Use-Up Quesadillas",
    totalTime: 12,
    servings,
    ingredients: [
      "tortillas", ...veg.map(v => v.name),
      prot ? swapForDiet(prot.name, diet) : null,
      dairy ? swapForDiet(dairy.name, diet) : "dairy-free spread (optional)"
    ].filter(Boolean),
    steps: [
      "Warm pan; add tortilla.",
      dairy ? "Sprinkle cheese; scatter veg (and protein)." : "Spread DF spread; scatter veg (and protein).",
      "Fold and toast both sides until crisp and melty.",
      "Slice and serve with salsa/greens if available."
    ],
    tags: ["zero_waste", "griddle", "quick"]
  };
  return { recipe, usedMass, uses };
}

function nextSaturdayFrom(now = new Date()) {
  const d = new Date(now);
  const day = d.getDay(); // 0=Sun..6=Sat
  const delta = (6 - day + 7) % 7 || 7;
  const sat = new Date(d.getFullYear(), d.getMonth(), d.getDate() + delta);
  return isoDate(sat);
}

function toZeroWasteList(uses = []) {
  // Deduplicate by name; keep largest qty
  const map = new Map();
  for (const u of uses) {
    const k = toStr(u.name);
    const prev = map.get(k);
    const qty = Number(u.qty ?? 1);
    if (!prev || qty > prev.qty) {
      map.set(k, { name: u.name, qty, unit: u.unit || "", note: "Used in zero-waste plan" });
    }
  }
  return Array.from(map.values());
}

/** Suggest next run times:
 *  - Friday 17:00 (default)
 *  - If any item has daysLeft <= 1 → also suggest tonight 18:00
 */
export function nextRuns(now = new Date(), ctx = {}) {
  const runs = [];
  const addAt = (h, m = 0) => {
    const d = new Date(now); d.setHours(h, m, 0, 0);
    if (d > now) runs.push(d.toISOString());
  };
  // default weekly suggestion
  addAt(17, 0);
  // opportunistic evening sweep
  const inputs = ctx?.inputs || {};
  const expiring = inputs.expiring || [];
  if (expiring.some(e => Number(e.daysLeft ?? 7) <= 1)) addAt(18, 0);
  return runs.length ? runs : [new Date(now.getTime() + 3 * 3600 * 1000).toISOString()];
}

/* ---------------- Execute ---------------- */

/**
 * Execute the template.
 * @param {Object} payload
 * @param {Array<Object>} payload.expiring
 * @param {Array<Object>} payload.leftovers
 * @param {Object} [payload.pantrySnapshot]
 * @param {Object} [payload.diet]
 * @param {Object} [payload.household]
 * @param {Object} [ctx]                    // { openUI?, runTemplate?, now? }
 * @returns {Promise<{ok:boolean, zeroWasteList:Array, simpleRecipes:Array, draft:boolean, scores:Array, actions:Array, message:string}>}
 */
export async function execute(payload, ctx = {}) {
  const { expiring = [], leftovers = [], pantrySnapshot, diet = {}, household = {} } = payload || {};
  const { openUI, runTemplate, now = new Date() } = ctx;

  if (!Array.isArray(expiring) || !Array.isArray(leftovers)) {
    throw new Error("fridgeZeroWasteSweep: 'expiring' and 'leftovers' must be arrays.");
  }

  // Pantry snapshot
  const pantry = pantrySnapshot || inventoryUtils.getSnapshot?.() || {};

  // Urgency-weighted list for scoring
  const urgencyByName = new Map(expiring.map((e) => [toStr(e.name), urgencyScore(e)]));

  // Build candidate plans (diet/pantry aware)
  const C = [
    buildSoup(expiring, leftovers, pantry, diet, household),
    buildStirFry(expiring, leftovers, pantry, diet, household),
    buildEggBake(expiring, leftovers, pantry, diet, household),
    buildFriedRice(expiring, leftovers, pantry, diet, household),
    buildQuesadillas(expiring, leftovers, pantry, diet, household)
  ];

  // Score by urgent-mass first (+bonus for shorter totalTime)
  const scored = C.map((c) => {
    const urgentMass = (c.uses || []).reduce((s, u) => s + (urgencyByName.get(toStr(u.name)) || 0), 0);
    const time = c.recipe?.totalTime || 0;
    const score = urgentMass * 10 - time; // big weight on urgency
    return { ...c, score };
  }).sort((a, b) => b.score - a.score);

  // keep top 2 non-empty
  const picks = scored.filter(x => (x.usedMass || 0) > 0 && x.recipe?.totalTime > 0).slice(0, 2);

  // Fallback to preservation if nothing to cook
  const totalUsed = picks.reduce((s, p) => s + (p.usedMass || 0), 0);
  if (totalUsed <= 0 && typeof runTemplate === "function") {
    try {
      await runTemplate("preserve_freezing_v1", {
        portions: leftovers.map((l) => ({ name: l.name, qty: l.qty, unit: l.unit, type: l.type || "leftover" }))
      });
      return {
        ok: true,
        zeroWasteList: [],
        simpleRecipes: [],
        draft: true,
        scores: [],
        actions: [],
        message: "Freezer packs suggested for leftovers (nothing to cook today)."
      };
    } catch (_) { /* continue */ }
  }

  const simpleRecipes = picks.map((p) => p.recipe);
  const zeroWasteList = toZeroWasteList(picks.flatMap((p) => p.uses));

  // Auto-draft the top pick to Saturday brunch (visible draft)
  const saturdayISO = nextSaturdayFrom(now);

  const actions = [];

  // OPEN_UI draft preview
  actions.push({
    type: "OPEN_UI",
    route: "/tier2/kitchen/zero-waste",
    component: "ZeroWastePlanner",
    params: {
      date: saturdayISO,
      topPick: simpleRecipes[0],
      altPick: simpleRecipes[1] || null,
      expiring,
      leftovers,
      diet,
      draft: true
    }
  });

  // PATCH_MEALPLAN (let orchestrator apply)
  actions.push({
    type: "PATCH_MEALPLAN",
    plan: { day: saturdayISO, recipeIds: [simpleRecipes[0]?.id].filter(Boolean) },
    draft: true
  });

  // Grocery cleanup for items we just used instead of buying
  actions.push({
    type: "GROCERY_DELETE",
    items: zeroWasteList.map((c) => c.name)
  });

  // Optional: calendar log
  try {
    const event = {
      start: now,
      end: new Date(now.getTime() + 20 * 60000),
      title: "Zero-Waste Sweep",
      description: simpleRecipes.map(r => `• ${r?.name} (${r?.totalTime}m)`).join("\n"),
      tags: ["zero_waste", "kitchen"],
      allDay: false
    };
    CalendarSyncModule?.load?.([event]);
    actions.push({ type: "CALENDAR_SYNC", events: [event], draft: true });
  } catch {}

  // Apply (best-effort) and grocery deletion in stores
  try {
    if (simpleRecipes[0] && MealPlanStore?.addQuickPlan) {
      MealPlanStore.addQuickPlan({
        day: saturdayISO,
        recipeIds: [simpleRecipes[0].id],
        meta: { title: simpleRecipes[0].name, tags: simpleRecipes[0].tags || ["zero_waste", "brunch"] }
      });
    }
  } catch {}
  try {
    const names = zeroWasteList.map(c => c.name);
    if (GroceryListStore?.deleteItemsByName) {
      GroceryListStore.deleteItemsByName(names);
    } else if (GroceryListStore?.removeMany) {
      GroceryListStore.removeMany(names.map((n) => ({ name: n })));
    }
  } catch {}

  // Heads-up notification
  try {
    NotificationCenter?.notify?.({
      title: "Zero-Waste Friday",
      message: `Drafted ${simpleRecipes[0]?.name} for Saturday brunch${simpleRecipes[1] ? " and queued a second option" : ""}.`,
      action: "Review",
      meta: { weekOf: saturdayISO, recipes: simpleRecipes }
    });
    actions.push({
      type: "NOTIFY",
      channel: "inbox",
      title: "Zero-Waste Friday",
      body: `Drafted ${simpleRecipes[0]?.name} for Saturday brunch. Tap to review.`,
      tags: ["zero_waste"]
    });
  } catch {}

  return {
    ok: true,
    zeroWasteList,
    simpleRecipes,
    draft: true,
    scores: scored.map(({ recipe, score, usedMass }) => ({ id: recipe?.id, name: recipe?.name, score, usedMass })),
    actions,
    message: template.success_message
  };
}

export default {
  template,
  execute,
  nextRuns
};
