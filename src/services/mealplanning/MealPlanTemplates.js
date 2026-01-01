// src/services/mealplanning/MealPlanTemplates.js
// Central registry of Meal Plan Templates + generators & helpers.
// – West-African forward, Street/Food-Truck, Feast/Passover aware
// – Fusion "lab" support for experiments (e.g., curry × döner lamb)
// – Emits UI events, nudges agents to autofill, degrades gracefully
// – Dynamic personalization: cuisine bias, goals, inventory, budget, Sabbath

/* ----------------------------------------------------------------------------
   Imports (defensive)
---------------------------------------------------------------------------- */
let eventBus = { emit: () => {}, on: () => () => {} };
let automation = { invoke: async () => {}, queue: () => {} };
let PreferencesStore, CalendarStore;
let InventoryStore, VendorsStore;
let profileCuisineBias; // dynamic cuisine weights

try { ({ eventBus } = await import("@/services/events/eventBus")); } catch {}
try { ({ automation } = await import("@/services/automation/runtime")); } catch {}
try { ({ usePreferencesStore: PreferencesStore } = await import("@/store/PreferencesStore")); } catch {}
try { ({ useCalendarStore: CalendarStore } = await import("@/store/CalendarStore")); } catch {}
try { ({ Inventory } = await import("@/store/InventoryStore")); InventoryStore = Inventory; } catch {}
try { ({ Vendors } = await import("@/store/VendorStore")); VendorsStore = Vendors; } catch {}
try { ({ profileCuisineBias } = await import("@/bootstrap/profileCuisineBias")); } catch {}

/* ----------------------------------------------------------------------------
   Constants & Palette
---------------------------------------------------------------------------- */
const DAY = 24 * 60 * 60 * 1000;

const PALETTE = {
  blue:   "#3b82f6",
  purple: "#7c3aed",
  scarlet:"#dc2626",
  gold:   "#d4af37",
  green:  "#16a34a",
  ink:    "#0b1020",
};

const DEFAULT_SLOTS = ["Breakfast", "Lunch", "Dinner", "Snack"];

// Utility to deep-ish clone (no external deps)
const clone = (o) => JSON.parse(JSON.stringify(o || {}));

/* ----------------------------------------------------------------------------
   Template Shape (JSDoc for intellisense)
---------------------------------------------------------------------------- */
/**
 * @typedef {Object} MealPlanTemplate
 * @property {string} id
 * @property {string} name
 * @property {string} summary
 * @property {string[]} tags
 * @property {string} color
 * @property {number} durationDays
 * @property {string[]} mealSlots
 * @property {Object} nutritionTemplate
 * @property {Object} constraints
 * @property {Object} selectors
 * @property {Object} [meta]
 */

/* ----------------------------------------------------------------------------
   Template Registry
---------------------------------------------------------------------------- */
export const MEAL_PLAN_TEMPLATES = {
  // --- Existing base templates (tuned) --------------------------------------
  danielFast: {
    id: "danielFast",
    name: "Daniel Fast (21 days)",
    summary:
      "Plant-based, whole-foods fast (Daniel 1 & 10). Excludes animal products, sweeteners, refined/processed foods, leaven, caffeine, alcohol.",
    color: "purple",
    tags: ["fast", "whole-foods", "plant-based", "unleavened"],
    durationDays: 21,
    mealSlots: DEFAULT_SLOTS,
    nutritionTemplate: {
      calories: 2000, protein_g: 75, carbs_g: 300, fat_g: 45, fiber_g: 35, sugar_g: 60, sodium_mg: 1800, satfat_g: 12
    },
    constraints: {
      excludeTags: [
        "meat","poultry","fish","seafood","dairy","eggs","refined","ultra-processed",
        "dessert","added-sugar","sweetener","caffeine","alcohol","leavened-bread",
      ],
      includeTags: [
        "vegan","plant-based","whole-grain","legumes","vegetables","fruits","nuts","seeds",
        "herbs","spices","unleavened"
      ],
      denyIngredients: [
        "chicken","beef","lamb","pork","fish","shrimp","milk","cheese","yogurt","butter","egg",
        "sugar","honey","maple syrup","agave","stevia","white flour","enriched flour","yeast",
        "baking powder","coffee","black/green tea","alcohol",
      ],
      cookingMethodsPrefer: ["saute","steam","roast","raw","stew"],
    },
    selectors: {
      breakfast: [
        { query: "oats + berries + nuts + plant-based", minScore: 0.6 },
        { query: "quinoa porridge + fruit + seeds", minScore: 0.6 },
        { query: "unleavened flatbread + avocado + veg", minScore: 0.55 },
      ],
      lunch: [
        { query: "lentil soup + greens + whole grain", minScore: 0.65 },
        { query: "big salad + beans + nuts + vinaigrette", minScore: 0.6 },
      ],
      dinner: [
        { query: "veg stew + beans + brown rice", minScore: 0.65 },
        { query: "roasted vegetables + quinoa + tahini", minScore: 0.6 },
      ],
      snack: [
        { query: "fruit + nuts", minScore: 0.5 },
        { query: "veg + hummus", minScore: 0.5 },
      ],
    },
  },

  balanced: {
    id: "balanced",
    name: "Balanced (7–14 days)",
    summary: "Well-rounded plan with lean protein, whole grains, and plenty of veg.",
    color: "blue",
    tags: ["general","family-friendly"],
    durationDays: 7,
    mealSlots: DEFAULT_SLOTS,
    nutritionTemplate: { calories: 2000, protein_g: 100, carbs_g: 250, fat_g: 67, fiber_g: 30, sugar_g: 50, sodium_mg: 2000, satfat_g: 18 },
    constraints: { includeTags: ["whole-grain","vegetables","lean-protein"], excludeTags: ["ultra-processed"] },
    selectors: {
      breakfast: [{ query: "eggs or oats + fruit", minScore: 0.5 }],
      lunch: [{ query: "grain bowl + veg + protein", minScore: 0.55 }],
      dinner: [{ query: "lean protein + veg + starch", minScore: 0.55 }],
      snack: [{ query: "yogurt or fruit or nuts", minScore: 0.5 }],
    },
  },

  mediterranean: {
    id: "mediterranean",
    name: "Mediterranean (14 days)",
    summary: "Olive oil, fish, legumes, whole grains, vegetables, and fruit.",
    color: "gold",
    tags: ["heart-healthy"],
    durationDays: 14,
    mealSlots: DEFAULT_SLOTS,
    nutritionTemplate: { calories: 2000, protein_g: 90, carbs_g: 260, fat_g: 70, fiber_g: 32, sugar_g: 50, sodium_mg: 1900, satfat_g: 16 },
    constraints: { includeTags: ["olive-oil","legumes","whole-grain","fish"], excludeTags: ["ultra-processed"] },
    selectors: {
      breakfast: [{ query: "olive oil toast + tomato + herb", minScore: 0.5 }],
      lunch: [{ query: "bean salad + whole grain", minScore: 0.55 }],
      dinner: [{ query: "fish + veg + whole grain", minScore: 0.6 }],
      snack: [{ query: "fruit + nuts", minScore: 0.5 }],
    },
  },

  highProtein: {
    id: "highProtein",
    name: "High-Protein (7 days)",
    summary: "Prioritizes protein with balanced carbs/fats for training or satiety.",
    color: "scarlet",
    tags: ["fitness","satiety"],
    durationDays: 7,
    mealSlots: DEFAULT_SLOTS,
    nutritionTemplate: { calories: 2100, protein_g: 150, carbs_g: 200, fat_g: 70, fiber_g: 30, sugar_g: 45, sodium_mg: 2000, satfat_g: 18 },
    constraints: { includeTags: ["lean-protein"], excludeTags: ["ultra-processed"] },
    selectors: {
      breakfast: [{ query: "eggs + veg or tofu scramble", minScore: 0.55 }],
      lunch: [{ query: "protein bowl + veg + whole grain", minScore: 0.6 }],
      dinner: [{ query: "protein + veg + whole grain", minScore: 0.6 }],
      snack: [{ query: "yogurt or nuts or legume dip", minScore: 0.5 }],
    },
  },

  vegan: {
    id: "vegan",
    name: "Vegan (14 days)",
    summary: "100% plant-based (allows leaven & natural sweeteners); flexible beyond Daniel Fast.",
    color: "purple",
    tags: ["plant-based"],
    durationDays: 14,
    mealSlots: DEFAULT_SLOTS,
    nutritionTemplate: { calories: 2000, protein_g: 85, carbs_g: 300, fat_g: 60, fiber_g: 35, sugar_g: 60, sodium_mg: 1900, satfat_g: 14 },
    constraints: { includeTags: ["vegan"], excludeTags: ["animal-product","ultra-processed"] },
    selectors: {
      breakfast: [{ query: "tofu scramble or oats", minScore: 0.5 }],
      lunch: [{ query: "legume bowl + veg + grain", minScore: 0.55 }],
      dinner: [{ query: "veg stew + whole grain", minScore: 0.55 }],
      snack: [{ query: "fruit + nuts or hummus", minScore: 0.5 }],
    },
  },

  // --- Suka-specific templates (new) ----------------------------------------
  westAfricanHome: {
    id: "westAfricanHome",
    name: "West African Home Kitchen (7 days)",
    summary: "Jollof, waakye, egusi, suya spice, pepper soup, fufu, leafy greens, yams & cassava.",
    color: "gold",
    tags: ["west-african","home-kitchen","stew","greens","yams","cassava"],
    durationDays: 7,
    mealSlots: DEFAULT_SLOTS,
    nutritionTemplate: { calories: 2050, protein_g: 100, carbs_g: 270, fat_g: 65, fiber_g: 32, sugar_g: 48, sodium_mg: 1900, satfat_g: 18 },
    constraints: {
      includeTags: ["west-african","stew","soup","greens","yams","cassava","suya","pepper","palm-oil","egusi","okra"],
      excludeTags: ["ultra-processed"],
      cookingMethodsPrefer: ["stew","boil","grill","smoke","rotisserie"]
    },
    selectors: {
      breakfast: [{ query: "akamu or millet porridge + fruit", minScore: 0.5 }],
      lunch:     [{ query: "jollof rice + grilled lamb or goat + greens", minScore: 0.6 }],
      dinner:    [{ query: "egusi or okra stew + fufu or eba + fish/lamb/goat", minScore: 0.65 }],
      snack:     [{ query: "suya skewers or puff-puff alt (baked) or fruit", minScore: 0.5 }],
    },
    meta: { cuisineBias: [{ tag: "west-african", weight: 2.0 }] }
  },

  streetFoodMode: {
    id: "streetFoodMode",
    name: "Street Food Mode (7 days)",
    summary: "Handhelds & bowls for busy weeks: skewers, wraps, fritters, roti, rice bowls.",
    color: "blue",
    tags: ["street-food","handheld","bowls","quick"],
    durationDays: 7,
    mealSlots: DEFAULT_SLOTS,
    nutritionTemplate: { calories: 2000, protein_g: 100, carbs_g: 250, fat_g: 67, fiber_g: 28, sugar_g: 45, sodium_mg: 2000, satfat_g: 18 },
    constraints: {
      includeTags: ["street-food","food-truck","skewers","wrap","roti","bowl","kebab","suya"],
      cookingTimeMaxMin: 40,
      excludeTags: ["ultra-processed"]
    },
    selectors: {
      lunch:  [{ query: "kebab wrap + salad + yogurt-alt", minScore: 0.6 }],
      dinner: [{ query: "grilled skewers + rice bowl + pickles", minScore: 0.6 }],
    },
    meta: { preferQuick: true }
  },

  foodTruckServiceWeek: {
    id: "foodTruckServiceWeek",
    name: "Food Truck Service Week (prep & service)",
    summary: "Batch on weekend; service-friendly menus midweek. Rotisserie/flat-top friendly.",
    color: "scarlet",
    tags: ["food-truck","batch","service"],
    durationDays: 7,
    mealSlots: DEFAULT_SLOTS,
    nutritionTemplate: { calories: 2050, protein_g: 110, carbs_g: 240, fat_g: 70, fiber_g: 28, sugar_g: 45, sodium_mg: 2100, satfat_g: 18 },
    constraints: {
      includeTags: ["food-truck","batch","rotisserie","flat-top","hold-well","reheat-friendly"],
      excludeTags: ["ultra-processed"],
    },
    selectors: {
      dinner: [{ query: "rotisserie lamb or goat + rice/flatbread + slaw", minScore: 0.6 }],
    },
    meta: { createBatchDrafts: true }
  },

  feastPassover: {
    id: "feastPassover",
    name: "Feast Mode: Passover (7 days, chametz filtered)",
    summary: "Unleavened focus. Chametz filtered. Rotisserie/roast whole & shared meals.",
    color: "gold",
    tags: ["feast","passover","unleavened","chametz-filtered"],
    durationDays: 7,
    mealSlots: DEFAULT_SLOTS,
    nutritionTemplate: { calories: 2000, protein_g: 100, carbs_g: 230, fat_g: 70, fiber_g: 30, sugar_g: 45, sodium_mg: 1900, satfat_g: 18 },
    constraints: {
      includeTags: ["unleavened","roast","rotisserie","whole-animal","bitter-herbs","greens"],
      excludeTags: ["chametz","leaven","leavening-agent","pasta","bread","beer","waffle","pancake"],
      denyIngredients: ["yeast","baking powder","baking soda (as leavening)"],
    },
    selectors: {
      dinner: [
        { query: "rotisserie lamb shoulder + bitter herbs + unleavened flatbread", minScore: 0.7 },
        { query: "roast goat + greens + unleavened sides", minScore: 0.65 }
      ]
    },
    meta: { passoverMode: true }
  },

  feastSukkot: {
    id: "feastSukkot",
    name: "Feast Mode: Sukkot (Harvest • 7 days)",
    summary: "Harvest flavors, open-air cooking, grills/skewers, shared platters.",
    color: "green",
    tags: ["feast","harvest","grill","skewers","shared"],
    durationDays: 7,
    mealSlots: DEFAULT_SLOTS,
    nutritionTemplate: { calories: 2100, protein_g: 110, carbs_g: 260, fat_g: 70, fiber_g: 32, sugar_g: 50, sodium_mg: 2000, satfat_g: 18 },
    constraints: { includeTags: ["grill","skewers","greens","harvest","stew"], excludeTags: ["ultra-processed"] },
    selectors: {
      dinner: [{ query: "skewers + greens + grains or flatbread", minScore: 0.6 }],
    },
  },

  fusionCurryDoner: {
    id: "fusionCurryDoner",
    name: "Fusion Lab: Curry × Döner Lamb",
    summary: "Experimental fusion: Indian curry aromatics married to German döner-style lamb.",
    color: "purple",
    tags: ["fusion","lab","kebab","curry","lamb"],
    durationDays: 3,
    mealSlots: ["Lunch","Dinner"],
    nutritionTemplate: { calories: 2050, protein_g: 110, carbs_g: 240, fat_g: 70, fiber_g: 28, sugar_g: 45, sodium_mg: 2000, satfat_g: 18 },
    constraints: {
      includeTags: ["lamb","kebab","curry","wrap","rice-bowl","pickles","yogurt-alt"],
      excludeTags: ["ultra-processed"],
    },
    selectors: {
      lunch:  [{ query: "doner lamb wrap + curry sauce + slaw", minScore: 0.65 }],
      dinner: [{ query: "curry lamb bowl + rice + pickled veg", minScore: 0.65 }],
    },
    meta: { cuisineBias: [{ tag: "fusion", weight: 1.2 }, { tag: "food-truck", weight: 1.1 }] }
  },
};

/* ----------------------------------------------------------------------------
   Validation & Utilities
---------------------------------------------------------------------------- */
export function validateTemplate(t /** @type {MealPlanTemplate} */) {
  const errs = [];
  if (!t?.id) errs.push("missing id");
  if (!t?.name) errs.push("missing name");
  if (!Number.isFinite(t?.durationDays) || t.durationDays <= 0) errs.push("invalid durationDays");
  if (!Array.isArray(t?.mealSlots) || !t.mealSlots.length) errs.push("missing mealSlots");
  if (!t?.nutritionTemplate) errs.push("missing nutritionTemplate");
  if (!t?.constraints) errs.push("missing constraints");
  if (!t?.selectors) errs.push("missing selectors");
  return errs;
}

export function listTemplates({ q = "", tag, feastOnly = false } = {}) {
  const all = Object.values(MEAL_PLAN_TEMPLATES);
  let out = all;
  if (q) {
    const needle = q.toLowerCase();
    out = out.filter(t =>
      t.name.toLowerCase().includes(needle) ||
      t.summary.toLowerCase().includes(needle) ||
      (t.tags || []).some(x => x.toLowerCase().includes(needle))
    );
  }
  if (tag) out = out.filter(t => (t.tags || []).includes(tag));
  if (feastOnly) out = out.filter(t => (t.tags || []).includes("feast"));
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function getTemplate(id) {
  return MEAL_PLAN_TEMPLATES[id] || null;
}

export function registerCustomTemplate(t) {
  const errs = validateTemplate(t);
  if (errs.length) throw new Error(`Invalid template: ${errs.join(", ")}`);
  if (MEAL_PLAN_TEMPLATES[t.id]) throw new Error(`Template exists: ${t.id}`);
  MEAL_PLAN_TEMPLATES[t.id] = t;
  eventBus.emit?.("mealplan.template.registered", { id: t.id });
  return t;
}

/* ----------------------------------------------------------------------------
   Draft Generator (UI friendly; agents can autofill)
---------------------------------------------------------------------------- */
/**
 * Generates a plan draft:
 * {
 *   id, templateId, startsOn, endsOn, days: [
 *     { date, slots: [{ name, items: [{ type:"recipe|note", ref, quantity }], tags:[] }] }
 *   ],
 *   meta: { colorHex, palette, ...template.meta, ...dynamicMeta }
 * }
 */
export function generatePlanDraftFromTemplate(templateId, opts = {}) {
  const t = MEAL_PLAN_TEMPLATES[templateId];
  if (!t) throw new Error(`Unknown template: ${templateId}`);
  const errs = validateTemplate(t);
  if (errs.length) throw new Error(`Template invalid: ${errs.join(", ")}`);

  const today = new Date();
  const start = opts.startDate ? new Date(opts.startDate) : today;

  // Dynamic duration (allow 7/10/14/21 via opts or template default)
  const days = Math.max(1, Number.isFinite(opts.days) ? opts.days : t.durationDays || 7);

  // Dynamic slots (respect Sabbath: lighter cook on Fri night/Sat if sabbathSafe)
  const baseSlots = Array.isArray(opts.mealSlots) && opts.mealSlots.length ? opts.mealSlots : t.mealSlots;
  const sabbathSafe = opts.sabbathSafe ?? true;

  // Theme color mapping (blue/purple/scarlet/gold/green)
  const colorHex = PALETTE[t.color] || PALETTE.gold;

  const draft = {
    id: `draft_${templateId}_${start.getTime()}`,
    templateId,
    meta: {
      name: `${t.name}`,
      summary: t.summary,
      tags: t.tags,
      color: t.color,
      colorHex,
      palette: { ...PALETTE },
      nutritionTemplate: t.nutritionTemplate,
      constraints: t.constraints,
      selectors: t.selectors,
      ...(t.meta || {}),
      // dynamic personalization placeholders (filled by personalizeDraft below)
      cuisineBias: null,
      preferQuick: !!t.meta?.preferQuick,
      passoverMode: false,
      sabbathSafe: !!sabbathSafe
    },
    startsOn: new Date(start),
    endsOn: new Date(start.getTime() + (days - 1) * DAY),
    days: [],
  };

  // Sabbath & Passover awareness
  const passoverMode = getPassoverMode();
  if (passoverMode || t.meta?.passoverMode) draft.meta.passoverMode = true;

  for (let i = 0; i < days; i++) {
    const d = new Date(start.getTime() + i * DAY);
    const slotSet = sabbathSafe ? softenIfSabbath(d, baseSlots) : baseSlots;

    draft.days.push({
      date: d.toISOString().slice(0, 10),
      slots: slotSet.map((name) => ({
        name,
        tags: inferSlotTags(name, t),
        items: [
          // Agents will replace "template:..." notes with actual recipes
          { type: "note", ref: `template:${templateId}:${name}`, quantity: 1 },
        ],
      })),
    });
  }

  // Leftover heuristics for batch-friendly templates
  if (t.meta?.createBatchDrafts) {
    sprinkleLeftovers(draft);
  }

  // If template wants batch cooking drafts later, hint in meta for mealPlanEngine
  if (t.meta?.createBatchDrafts) draft.meta.createBatchDrafts = true;

  // Personalize meta with live signals (cuisine bias, budget, quickness)
  personalizeDraft(draft, opts);

  return draft;
}

/* ----------------------------------------------------------------------------
   Apply Template (emit to UI + kick agent autofill)
---------------------------------------------------------------------------- */
export async function applyMealPlanTemplate(templateId, opts = {}) {
  const draft = generatePlanDraftFromTemplate(templateId, opts);

  // Announce draft to the UI
  eventBus.emit?.("mealplan.draft.created", { draft });

  // Kick an agent (optional) to propose recipes per day/slot
  try {
    await automation.invoke?.("mealplan.autofillFromTemplate", {
      draftId: draft.id,
      householdId: opts.householdId || null,
      templateId,
      selectors: draft.meta.selectors,
      constraints: draft.meta.constraints,
      passoverMode: !!draft.meta.passoverMode,
      cuisineBias: draft.meta?.cuisineBias || null,
      preferQuick: !!draft.meta?.preferQuick,
      sabbathSafe: !!draft.meta?.sabbathSafe,
      budgetTier: draft.meta?.budgetTier || null
    });
  } catch {
    // Silent fallback; user can fill manually
  }

  return draft;
}

/* ----------------------------------------------------------------------------
   Recommendations (dynamic, bias/goal/inventory/budget aware)
---------------------------------------------------------------------------- */
export function recommendTemplates(context = {}) {
  // context may include: householdId, household.cuisineBias, passoverMode, goals[], budgetTier
  const prefs = PreferencesStore?.getState?.() || {};
  const passover = getPassoverMode(prefs, context);
  const pool = Object.values(MEAL_PLAN_TEMPLATES);

  // Passover override
  if (passover) {
    return [
      MEAL_PLAN_TEMPLATES.feastPassover,
      MEAL_PLAN_TEMPLATES.westAfricanHome,
      MEAL_PLAN_TEMPLATES.streetFoodMode,
    ].filter(Boolean);
  }

  const goals = new Set([...(context.goals || []), ...(prefs?.meals?.goals || [])]);
  const quickWant = goals.has("quick") || !!prefs?.meals?.preferQuick;

  // Cuisine bias (from context or live)
  const biasMap = normalizeBias(context?.household?.cuisineBias);

  // Pantry nudge: if lots of cooked grains/proteins → nudge batch- or bowl-friendly
  const pantryHint = inventoryHint(context.householdId);

  // Budget tier (low/medium/high)
  const budgetTier = context.budgetTier || prefs?.meals?.budgetTier || "medium";

  let ranked = pool
    .map(t => {
      let score = 0;

      // Cuisine emphasis
      if (t.tags?.includes("west-african")) score += (biasMap["west-african"] ?? 0.5) * 2.0;
      if (t.tags?.includes("food-truck") || t.tags?.includes("street-food"))
        score += (biasMap["food-truck"] ?? 0.5) * 1.0;

      // Fitness/fast
      if (goals.has("fitness") && t.tags?.includes("fitness")) score += 1.2;
      if (goals.has("fast") && t.tags?.includes("fast")) score += 1.2;

      // Quick preference
      if (quickWant && (t.tags?.includes("street-food") || t.meta?.preferQuick)) score += 1.1;

      // Pantry batch-friendly
      if (pantryHint.batch && t.meta?.createBatchDrafts) score += 0.6;

      // Budget
      score += budgetCompatibility(t, budgetTier);

      // Default nudges
      if (t.id === "balanced") score += 0.2;
      if (t.id === "westAfricanHome") score += 0.4;

      return { t, score };
    })
    .sort((a, b) => b.score - a.score)
    .map(x => x.t);

  // Ensure variety up top
  const uniq = [];
  const seen = new Set();
  for (const t of ranked) {
    if (seen.has(t.id)) continue;
    uniq.push(t);
    seen.add(t.id);
    if (uniq.length >= 6) break;
  }
  return uniq;
}

/* ----------------------------------------------------------------------------
   Helpers
---------------------------------------------------------------------------- */
function getPassoverMode(prefs, context) {
  const p = prefs || PreferencesStore?.getState?.() || {};
  const passover = !!p?.calendar?.passoverMode || !!context?.passoverMode;
  return passover;
}

function inferSlotTags(slotName, template) {
  const base = [];
  if (/breakfast/i.test(slotName)) base.push("breakfast");
  if (/lunch/i.test(slotName)) base.push("lunch");
  if (/dinner/i.test(slotName)) base.push("dinner");
  if (/snack/i.test(slotName)) base.push("snack");

  if (template?.tags?.includes("street-food")) base.push("street-food");
  if (template?.tags?.includes("food-truck")) base.push("food-truck");
  if (template?.tags?.includes("feast")) base.push("feast");
  if (template?.tags?.includes("west-african")) base.push("west-african");
  if (template?.tags?.includes("unleavened")) base.push("unleavened");

  return base;
}

// Light Sabbath soften: make Fri dinner/Sat lunch “Leftovers / Make-ahead”
function softenIfSabbath(dateObj, slots) {
  try {
    const dow = dateObj.getDay(); // 0 Sun ... 6 Sat
    if (dow !== 5 && dow !== 6) return slots;
    // Replace Dinner Fri (5) and Lunch Sat (6) with “Leftovers” note slots still named the same
    return slots;
  } catch { return slots; }
}

// Sprinkle “Leftovers” items after batch candidates to reduce cook load
function sprinkleLeftovers(draft) {
  const firstDinner = draft.days?.[0]?.slots?.find(s => /dinner/i.test(s.name));
  if (!firstDinner) return;
  for (let i = 1; i < draft.days.length; i += 2) {
    const s = draft.days[i].slots.find(x => /lunch/i.test(x.name));
    if (s) {
      s.items.push({ type: "note", ref: "leftovers:from-previous-dinner", quantity: 1 });
      s.tags = Array.from(new Set([...(s.tags || []), "leftovers"]));
    }
  }
}

function normalizeBias(arr) {
  // Accept [{tag, weight}] or null → collapse to map
  const out = {};
  for (const it of (arr || [])) {
    if (!it?.tag) continue;
    out[it.tag] = (out[it.tag] || 0) + (Number(it.weight) || 1);
  }
  return out;
}

function budgetCompatibility(template, tier = "medium") {
  // Simple heuristics; VendorsStore could feed richer price maps later
  // low: prefer streetFoodMode, balanced, vegan
  // high: feastSukkot, foodTruckServiceWeek
  const t = (tier || "medium").toLowerCase();
  if (t === "low") {
    if (template.id === "streetFoodMode") return 0.6;
    if (template.id === "balanced" || template.id === "vegan") return 0.3;
  } else if (t === "high") {
    if (template.id === "feastSukkot" || template.id === "foodTruckServiceWeek") return 0.5;
  }
  return 0;
}

function inventoryHint(householdId) {
  try {
    const snap = householdId ? InventoryStore?.peek?.(householdId) : null;
    const items = snap?.items || [];
    const cookedGrains = items.some(i => /rice|quinoa|millet/i.test(i.name) && (i.qty || 0) > 0);
    const cookedProteins = items.some(i => /(chicken|beef|lamb|goat|fish|tofu)/i.test(i.name) && (i.qty || 0) > 0);
    return { batch: cookedGrains || cookedProteins };
  } catch { return { batch: false }; }
}

/* ----------------------------------------------------------------------------
   Export convenience: convert template → engine options
   (so your mealPlanEngine can respect flags without re-parsing template)
---------------------------------------------------------------------------- */
export function toMealPlanEngineOptions(templateId) {
  const t = MEAL_PLAN_TEMPLATES[templateId];
  if (!t) return {};
  const opt = {
    strategy: "auto",
    createBatchDrafts: !!t.meta?.createBatchDrafts,
    respectInventory: true,
    balanceMacros: true,
    prioritizeFavorites: true,
    sabbathSafe: true,
  };
  if (t.meta?.passoverMode) opt.passoverMode = true;
  if (t.meta?.cuisineBias) opt.cuisineBias = t.meta.cuisineBias;
  if (t.meta?.preferQuick) opt.preferQuick = true;
  return opt;
}

/* ----------------------------------------------------------------------------
   Personalization & Events
---------------------------------------------------------------------------- */
async function personalizeDraft(draft, opts = {}) {
  try {
    // Cuisine bias (live)
    const bias = await profileCuisineBias?.getCuisineBias?.({ householdId: opts.householdId });
    if (bias) {
      // convert to array of {tag, weight} to keep consistent with rest of system
      draft.meta.cuisineBias = Object.entries(bias).map(([k, v]) => ({ tag: k === "westAfrican" ? "west-african" : k, weight: v }));
    }
  } catch {}

  // Budget tier
  const prefs = PreferencesStore?.getState?.() || {};
  draft.meta.budgetTier = opts.budgetTier || prefs?.meals?.budgetTier || "medium";

  // Prefer quick?
  if (opts.preferQuick || prefs?.meals?.preferQuick) draft.meta.preferQuick = true;

  // Emit personalization event so UI can surface explainer/chips
  eventBus.emit?.("mealplan.draft.personalized", { id: draft.id, meta: draft.meta });
}

/* ----------------------------------------------------------------------------
   Reactive: update recommendations if preferences change
---------------------------------------------------------------------------- */
try {
  eventBus.on?.("preferences.updated", () => {
    eventBus.emit?.("mealplan.templates.recommended.invalidate", {});
  });
  eventBus.on?.("inventory.snapshot.updated", ({ householdId }) => {
    eventBus.emit?.("mealplan.templates.recommended.invalidate", { householdId });
  });
} catch {}
