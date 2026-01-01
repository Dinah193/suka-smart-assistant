// src/services/templates/prepTonightForTomorrow.js

import * as MealPlanStore from "@/store/MealPlanStore";
import * as RecipeStore from "@/store/RecipeStore";
import * as inventoryUtils from "@/utils/inventoryUtils";
import * as timeUtils from "@/utils/timeUtils";
import ReminderManager from "@/managers/ReminderManager";

// Optional/guarded modules (non-fatal if absent)
let NotificationCenter, CalendarSyncModule, DietProfileStore, UserSettingsStore;
try { NotificationCenter = require("@/managers/NotificationCenter").default; } catch (_) {}
try { CalendarSyncModule = require("@/services/calendar/CalendarSyncModule").default; } catch (_) {}
try { DietProfileStore = require("@/store/DietProfileStore"); } catch (_) {}
try { UserSettingsStore = require("@/store/UserSettingsStore"); } catch (_) {}

/**
 * Contract-compliant template metadata
 */
export const template = {
  id: "prep_tonight_for_tomorrow_v2",
  version: "2.1.0",
  purpose: "Remove morning chaos—do tiny prep now, tailored to your plan, calendar, fridge space, and preferences.",
  triggers: ["time::20:30_local", "calendar::early_meeting_tomorrow", "ui::PrepTonight.open"],
  inputs: {
    required: [],
    optional: [
      "mealPlanTomorrow",          // { recipeIds: [] }
      "fridgeSpace",               // { available?: boolean, litersFree?: number }
      "tools",                     // string[]
      "inventorySnapshot",         // { items: [...] } optional override
      "earlyTomorrow",             // ISO string or boolean hint to prioritize breakfast/lunch speed
      "avoidList"                  // string[] (diet/allergen dislikes)
    ]
  },
  logic: {
    selectors: [
      "MealPlanStore.getDay(tomorrow)",
      "MealPlanStore.getBreakfast/Lunch? (if available in your store)",
      "RecipeStore.getById(id)",
      "inventoryUtils.getSnapshot()",
      "DietProfileStore.get()?.avoid | allergens (optional)",
      "CalendarSyncModule.getTomorrowFirstEvent? to infer early morning rush (optional)"
    ],
    rules: [
      "Only include prep items that take ≤10 minutes total.",
      "Prefer prep that increases morning speed or dinner quality (thaw/marinade/soak/chop/wash).",
      "If tomorrow has an early event, prioritize breakfast/lunch helpers (overnight oats, cold brew set, pre-portion fruit/snacks).",
      "Respect diet/avoid list when proposing aromatics or prep foods.",
      "If no plan exists, run Quick Suggest (#1) targeting tomorrow, then build micro-prep.",
      "If freezer/fridge space is tight, avoid thaw/marinade tasks."
    ],
    llm_roles: []
  },
  actions: [
    "OPEN_UI:PrepChecklistGenerator.jsx",
    "NOTIFY:gentle reminders (two)",
    "CALENDAR:optional quick 'Morning grab-and-go' stub"
  ],
  outputs: {
    ui: ["PrepChecklistGenerator.jsx"],
    data: ["microPrepList", "advisories"],
    alerts: []
  },
  fallbacks: [
    "If no plan → Quick Suggest (#1) to create a simple plan for tomorrow."
  ],
  success_message: "All set. A 5–10 minute prep list is ready for tonight.",
  used_by: ["cookingAgent"]
};

/* ---------------- utilities ---------------- */

const toKey = (s) => String(s || "").toLowerCase().trim();

function getTomorrowISO(now = new Date()) {
  if (typeof timeUtils?.addDays === "function" && typeof timeUtils?.toLocalISODate === "function") {
    return timeUtils.toLocalISODate(timeUtils.addDays(now, 1));
  }
  const t = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const y = t.getFullYear();
  const m = String(t.getMonth() + 1).padStart(2, "0");
  const d = String(t.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function hasAny(inv, names = []) {
  const items = inv?.items || inv || [];
  const map = Array.isArray(items)
    ? items.reduce((a, it) => (a[toKey(it.name)] = Number(it.qty ?? it.quantity ?? 0), a), {})
    : Object.fromEntries(Object.entries(items).map(([k, v]) => [toKey(k), Number(v ?? 0)]));
  return names.some((n) => (map[toKey(n)] ?? 0) > 0);
}

/**
 * Try to infer “early morning tomorrow” from hints or calendar (best-effort).
 */
function looksEarlyTomorrow(earlyTomorrow, now = new Date()) {
  if (typeof earlyTomorrow === "boolean") return earlyTomorrow;
  if (earlyTomorrow && typeof earlyTomorrow === "string") return true;
  try {
    const first = CalendarSyncModule?.getTomorrowFirstEvent?.(now);
    if (!first) return false;
    const hour = new Date(first.start).getHours();
    return hour <= 9; // anything at or before 9am counts as early rush
  } catch (_) {
    return false;
  }
}

/* ---------------- micro-prep builders ---------------- */

function buildDinnerMicroPrep(recipes = [], { tools = [], fridgeSpace = {}, avoidSet } = {}) {
  const tasks = [];
  const lowerIncludes = (s, arr) => {
    const t = String(s || "").toLowerCase();
    return arr.some((k) => t.includes(k));
  };
  const hasKnife = tools.includes?.("knife") || tools.includes?.("chef_knife") || true;
  const tightFridge = fridgeSpace?.available === false || Number(fridgeSpace?.litersFree || 0) < 2;

  for (const r of recipes) {
    const rid = r.id ?? r.name ?? `r_${Math.random().toString(36).slice(2, 8)}`;
    const ing = (r.ingredients ?? []).map((i) => (typeof i === "string" ? i : i.name || ""));

    const containsAvoid = (names) => names.some((n) => avoidSet?.has?.(toKey(n)));
    if (containsAvoid(ing)) {
      // skip chopping preps if user avoids the ingredient
      // we'll still allow generic tasks like thaw/soak if the avoided ingredient isn't that item
    }

    // Thaw (skip if tight fridge)
    const needsThaw =
      ing.some((name) => lowerIncludes(name, ["frozen", "freezer", "ice"])) ||
      lowerIncludes(r.name, ["frozen", "freezer"]);
    if (needsThaw && !tightFridge) {
      tasks.push({
        id: `thaw_${rid}`,
        title: `Move ${r.name} components from freezer to fridge`,
        estMinutes: 2,
        note: "Place on a tray to catch drips; bottom shelf preferred.",
        tags: ["thaw", "food_safety"]
      });
    }

    // Soak
    const needsSoak = ing.some((name) =>
      lowerIncludes(name, [
        "dried beans", "dry beans", "lentil", "chickpea", "garbanzo",
        "oat", "farro", "wheat berry", "barley", "brown rice", "wild rice"
      ])
    );
    if (needsSoak) {
      tasks.push({
        id: `soak_${rid}`,
        title: `Start soak for tomorrow’s ${r.name} base`,
        estMinutes: 3,
        note: "Rinse, then cover with cool water + pinch of salt; label the bowl.",
        tags: ["soak"]
      });
    }

    // Marinate (skip if tight fridge)
    const likelyProtein = ing.some((name) =>
      lowerIncludes(name, ["chicken", "beef", "lamb", "goat", "fish", "steak", "thigh", "breast", "roast", "ground"])
    );
    const mentionsMarinade =
      lowerIncludes(r.name, ["marinade", "marinated"]) ||
      (r.tags ?? []).some((t) => lowerIncludes(t, ["marinade", "marinate"])) ||
      (r.steps ?? []).some((s) => lowerIncludes(s, ["marinate"]));
    if (likelyProtein && mentionsMarinade && !tightFridge) {
      tasks.push({
        id: `marinate_${rid}`,
        title: `Mix & marinate ${r.name} protein`,
        estMinutes: 8,
        note: "Bag or shallow pan; keep below 41°F in fridge; label time.",
        tags: ["marinate", "food_safety"]
      });
    }

    // Chop aromatics (avoid if in avoidSet)
    const aromaticHits = ing.filter((name) =>
      lowerIncludes(name, ["onion", "garlic", "scallion", "green onion", "shallot", "cilantro", "parsley", "dill"])
    );
    const safeAromatics = aromaticHits.filter((n) => !avoidSet?.has?.(toKey(n)));
    const needsChop = hasKnife && safeAromatics.length > 0;
    if (needsChop) {
      tasks.push({
        id: `chop_${rid}`,
        title: `Dice aromatics for ${r.name}`,
        estMinutes: 7,
        note: "Store in sealed container to avoid fridge odors.",
        tags: ["chop"]
      });
    }

    // Wash/portion produce (skip if thaw already planned for same dish to keep list short)
    const needsWash =
      ing.some((name) => lowerIncludes(name, ["lettuce", "greens", "kale", "spinach", "berries", "herbs"])) &&
      !needsThaw;
    if (needsWash) {
      tasks.push({
        id: `wash_${rid}`,
        title: `Wash & spin produce for ${r.name}`,
        estMinutes: 6,
        note: "Dry well to keep crisp overnight.",
        tags: ["wash"]
      });
    }
  }

  // Keep ≤10-minute quick list: cap to 6 items
  return tasks.filter((t) => (t.estMinutes ?? 0) <= 10).slice(0, 6);
}

/**
 * Breakfast/Lunch helpers for early mornings (5–10 minutes total).
 */
function buildMorningHelpers({ inventorySnapshot, avoidSet }) {
  const tasks = [];
  const inv = inventorySnapshot || { items: {} };

  // Overnight oats
  if (hasAny(inv, ["oats", "rolled oats"]) && hasAny(inv, ["milk", "oat milk", "almond milk", "yogurt"])) {
    tasks.push({
      id: "overnight_oats",
      title: "Mix overnight oats (grab-and-go)",
      estMinutes: 4,
      note: "Oats + milk/yogurt, pinch of salt; jar & chill.",
      tags: ["breakfast"]
    });
  }

  // Cold brew set (only if coffee drinker not avoided)
  if (!avoidSet?.has?.("coffee") && hasAny(inv, ["coffee"])) {
    tasks.push({
      id: "cold_brew_set",
      title: "Start cold brew (tomorrow AM ready)",
      estMinutes: 3,
      note: "Coarse grind + water in jar; steep in fridge.",
      tags: ["breakfast", "beverage"]
    });
  }

  // Fruit/snack boxes
  if (hasAny(inv, ["apple", "banana", "berries", "grapes"]) || hasAny(inv, ["nuts", "trail mix"])) {
    tasks.push({
      id: "portion_snacks",
      title: "Pre-portion fruit & snacks",
      estMinutes: 5,
      note: "Two boxes for tomorrow (work/school).",
      tags: ["grab_and_go"]
    });
  }

  return tasks.slice(0, 3);
}

/* ---------------- reminders & fallbacks ---------------- */

function scheduleGentleReminders(now = new Date()) {
  const plus10 =
    (typeof timeUtils?.addMinutes === "function" && timeUtils.addMinutes(now, 10)) ||
    new Date(now.getTime() + 10 * 60 * 1000);

  let ninePM;
  if (typeof timeUtils?.setLocalTime === "function") {
    ninePM = timeUtils.setLocalTime(now, 21, 0, 0);
  } else {
    ninePM = new Date(now); ninePM.setHours(21, 0, 0, 0);
  }

  ReminderManager.schedule?.({
    at: plus10,
    title: "Tiny prep now?",
    message: "5–10 minutes is enough. I opened your prep checklist.",
    tags: ["prep", "evening"]
  });

  ReminderManager.schedule?.({
    at: ninePM,
    title: "Last call: quick prep",
    message: "If you haven’t, knock out 1–2 prep items before bed.",
    tags: ["prep", "evening"]
  });

  // Optional heads-up toast/notification
  try {
    NotificationCenter?.notify?.({
      title: "Prep tonight ready",
      message: "Open your checklist—two gentle reminders scheduled.",
      action: "Open"
    });
  } catch (_) {}
}

/**
 * Ensure tomorrow has at least one meal planned.
 * Try Quick Suggest (#1) with a tomorrow override; else return a pantry pasta stub.
 */
async function ensurePlanForTomorrow(tomorrowISO, ctx) {
  if (ctx?.runTemplate) {
    try {
      const res = await ctx.runTemplate(
        "quick_suggest_dinner_v1",
        { timeAvailable: 30 },
        { dayOverride: tomorrowISO }
      );
      return res?.picks ?? [];
    } catch (_) {}
  }
  return [
    {
      id: "pantry_pasta_15m",
      name: "Pantry Pasta (Garlic & Oil)",
      servings: 2,
      totalTime: 15,
      ingredients: ["dry pasta", "olive oil", "garlic", "salt"],
      steps: [
        "Boil pasta until al dente.",
        "Warm oil with sliced garlic until fragrant (do not brown).",
        "Toss pasta with oil; salt to taste."
      ],
      tags: ["quick", "pantry"]
    }
  ];
}

/* ---------------- execute ---------------- */

/**
 * Execute the template.
 * @param {Object} payload
 * @param {Object} [payload.mealPlanTomorrow]
 * @param {Object} [payload.fridgeSpace]
 * @param {Array<string>} [payload.tools]
 * @param {Object} [payload.inventorySnapshot]
 * @param {string|boolean} [payload.earlyTomorrow]
 * @param {Array<string>} [payload.avoidList]
 * @param {Object} [ctx] - { openUI?, runTemplate?, now? }
 * @returns {Promise<{microPrepList:Array, advisories:Array, message:string}>}
 */
export async function execute(payload = {}, ctx = {}) {
  const {
    mealPlanTomorrow,
    fridgeSpace = {},
    tools = [],
    inventorySnapshot: snapshotIn,
    earlyTomorrow,
    avoidList = []
  } = payload;

  const { openUI, runTemplate, now = new Date() } = ctx;

  const tomorrowISO = getTomorrowISO(now);

  // Resolve avoid set (from payload + diet profile store)
  const dietAvoids = (DietProfileStore?.get?.()?.avoid || []).concat(DietProfileStore?.get?.()?.allergens || []);
  const avoidSet = new Set([...avoidList, ...dietAvoids].map(toKey));

  // Inventory snapshot (optional override)
  const inventorySnapshot =
    snapshotIn ??
    inventoryUtils.getSnapshot?.() ??
    { items: {} };

  // 1) Resolve tomorrow’s meal plan
  let plan = mealPlanTomorrow || MealPlanStore.getDay?.(tomorrowISO);
  let recipeIds = (plan?.recipeIds ?? []).filter(Boolean);

  // 2) If no plan, fallback to Quick Suggest (#1) targeting tomorrow
  if (recipeIds.length === 0) {
    const fallbackRecipes = await ensurePlanForTomorrow(tomorrowISO, ctx);
    const idsFromStore = fallbackRecipes
      .map((r) => (r.id ? (RecipeStore.getById?.(r.id)?.id || null) : null))
      .filter(Boolean);

    recipeIds = idsFromStore;

    // If store doesn’t have them, ensure PlanStore gets a placeholder
    if (recipeIds.length === 0) {
      try {
        MealPlanStore.addQuickPlan?.({ day: tomorrowISO, recipeIds: ["pantry_pasta_15m"] });
      } catch (_) {}
    }
  }

  // 3) Load recipe objects
  const recipes = recipeIds.length
    ? recipeIds.map((id) => RecipeStore.getById?.(id)).filter(Boolean)
    : [RecipeStore.getById?.("pantry_pasta_15m")].filter(Boolean);

  // 4) Build dinner micro-prep list (≤10 minutes)
  const dinnerPrep = buildDinnerMicroPrep(recipes, { tools, fridgeSpace, avoidSet });

  // 5) If early morning → add breakfast/lunch helpers (≤10 minutes total extra)
  const early = looksEarlyTomorrow(earlyTomorrow, now);
  const morningHelpers = early ? buildMorningHelpers({ inventorySnapshot, avoidSet }) : [];

  // Cap to ~10–15 minutes total: prefer thaw/soak/marinade first, then morning helpers, then chop/wash
  const priority = (t) =>
    (t.tags?.includes("thaw") || t.tags?.includes("soak") || t.tags?.includes("marinate")) ? 3 :
    (t.tags?.includes("breakfast") || t.tags?.includes("grab_and_go") || t.tags?.includes("beverage")) ? 2 :
    1;

  const all = [...dinnerPrep, ...morningHelpers].sort((a, b) => priority(b) - priority(a));
  let totalMin = 0;
  const microPrepList = [];
  for (const t of all) {
    const m = Number(t.estMinutes ?? 0);
    if (totalMin + m > 15) continue;
    microPrepList.push(t);
    totalMin += m;
  }

  // 6) Advisories (food safety / fridge constraints / missing items)
  const advisories = [];
  if (microPrepList.some((t) => t.tags?.includes("thaw"))) {
    advisories.push("Thawing in fridge overnight only; keep items on a tray on the bottom shelf.");
  }
  if (fridgeSpace?.available === false) {
    advisories.push("Fridge space tight—skipped thaw/marinade tasks.");
  }
  // Light “missing” hint for helpers
  if (early && !hasAny(inventorySnapshot, ["oats", "rolled oats"])) {
    advisories.push("No oats detected; overnight oats skipped.");
  }

  // 7) Open PrepChecklistGenerator with tonight’s micro-tasks
  const params = {
    day: tomorrowISO,
    tasks: microPrepList,
    advisories
  };

  if (typeof openUI === "function") {
    openUI("PrepChecklistGenerator", params);
  } else {
    window.dispatchEvent(new CustomEvent("ui:navigate", { detail: { route: "PrepChecklistGenerator", params } }));
  }

  // 8) Optional calendar stub if early morning
  try {
    if (early) {
      const morning = typeof timeUtils?.setLocalTime === "function" ? timeUtils.setLocalTime(new Date(now.getTime() + 24*60*60*1000), 7, 0, 0) : new Date(new Date(now.getTime() + 24*60*60*1000).setHours(7,0,0,0));
      CalendarSyncModule?.load?.([{
        start: morning,
        end: new Date(morning.getTime() + 30 * 60 * 1000),
        allDay: false,
        title: "Grab-and-go ready",
        description: "Snacks/overnight oats prepped tonight.",
        tags: ["prep"]
      }]);
    }
  } catch (_) {}

  // 9) Schedule two gentle reminders
  scheduleGentleReminders(now);

  return {
    microPrepList,
    advisories,
    message: template.success_message
  };
}

export default {
  template,
  execute
};
