// C:\Users\larho\suka-smart-assistant\src\services\planning\generateMealTimeline.js
/**
 * generateMealTimeline (Dynamic, Cross-Module)
 * --------------------------------------------
 * Builds a day-by-day meal plan + integrated timeline/events with:
 *  - Preferences (cadence, portions, Sabbath-aware quiet windows)
 *  - Forecast (garden/homegrown) + Inventory to reduce grocery list
 *  - Batch-cooking session suggestions
 *  - Timers + voice cues for MultiTimerPanel
 *  - Nutrition rollups (best-effort)
 *  - Label stubs for packaged meals
 *  - Calendar export stubs (local/google/microsoft)
 *
 * Resilient by design: optional internal services are required() best-effort.
 */

const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc"); dayjs.extend(utc);

let InventoryService, NutritionService, PreferencesService, UnitConverter;
try { InventoryService = require("../../features/inventory/services/InventoryService").default; } catch {}
try { NutritionService = require("../../features/nutrition/services/nutritionLookupService").default; } catch {}
try { PreferencesService = require("../../services/preferences/PreferencesService").default; } catch {}
try { UnitConverter = require("../../lib/unitConverter").default; } catch {}

const DEFAULT_PREFS = {
  meals: {
    portions: { default: 4, adults: 2, children: 2 },
    cadence: { breakfast: true, lunch: true, dinner: true, snacks: false },
    proteins: ["chicken", "beef", "fish"],
    breads: ["wheat", "white", "sourdough", "cornbread"],
    veggies: ["lettuce", "spinach", "tomato", "broccoli", "onion", "pepper"],
    batchCooking: { enabled: true, sessionDay: "Sunday", sessionHour: 14, warmUpTips: true, daysPerBatch: 2, maxRecipesPerBatch: 6 },
    donenessHints: { vegetables: "tender-crisp", meat: "medium" },
  },
  calendar: { sabbathAware: true, sabbathSunsetOffsetMin: 30, provider: "local", exportEvents: false, blockQuietWindows: false },
  timers: { generate: true, voiceAlerts: true },
  labels: { generate: true, defaultShelfLife: "3 months frozen" },
  nutrition: { computePerMeal: true, targetMacros: null },
  integrateGarden: true,
  integrateInventory: true,
  pacing: "normal", // aggressive | normal | leisurely
};

const SLOT_KEYS = ["breakfast", "lunch", "dinner"];

/* ───────────────────────── helpers ───────────────────────── */

function keyOf(x) {
  return String(x || "").toLowerCase().replace(/\s+/g, "_");
}
function rotatePick(arr, idx) {
  if (!arr || arr.length === 0) return null;
  return arr[idx % arr.length];
}
function sabbathWindow(dateISO, sabbathSunsetOffsetMin = 30, fridaySunset = null, saturdaySunset = null) {
  const fri = dayjs(dateISO).day(5);
  const sat = dayjs(dateISO).day(6);
  const friSunset = fridaySunset ? dayjs(fridaySunset) : fri.hour(18).minute(0);
  const satSunset = saturdaySunset ? dayjs(saturdaySunset) : sat.hour(18).minute(0);
  const stopCookingBy = friSunset.subtract(sabbathSunsetOffsetMin || 0, "minute");
  return { start: stopCookingBy, end: satSunset };
}

/* ───────────────── recipes: normalize + fallback ─────────── */

function normalizeRecipes(recipes = []) {
  return (recipes || []).map((r, i) => ({
    id: r.id || `recipe_${i}`,
    title: r.name || r.title || `Recipe ${i + 1}`,
    slotHint: r.slotHint || r.category || null,
    ingredients: Array.isArray(r.ingredients)
      ? r.ingredients.map((ing) => ({
          name: ing.name || ing.item || String(ing),
          qty: Number(ing.qty || ing.quantity || 0),
          unit: ing.unit || "",
        }))
      : [],
    steps: Array.isArray(r.instructions) ? r.instructions : r.steps || [],
    tags: r.tags || [],
    timeMin: r.timeMin || r.totalTimeMin || 30,
    servings: r.servings || 4,
    allergens: r.allergens || [],
    dietTags: r.dietTags || [],
  }));
}

function makeFallbackRecipe({ protein, veg, carb, slot = "dinner", portions = 4, prefs = DEFAULT_PREFS }) {
  const vegDoneness = prefs.meals?.donenessHints?.vegetables || "tender-crisp";
  const meatDoneness = prefs.meals?.donenessHints?.meat || "medium";
  const title = `${protein} + ${veg} with ${carb}`;
  const ingredients = [
    { name: protein, qty: portions * 0.4, unit: "lb" },
    { name: veg, qty: portions * 0.25, unit: "lb" },
    { name: carb, qty: portions, unit: "serving" },
    { name: "salt", qty: 1, unit: "tsp" },
    { name: "oil", qty: portions * 0.5, unit: "tbsp" },
  ];
  const steps = [
    `Prep: wash/chop ${veg}.`,
    `Cook ${protein} to your preferred doneness (${meatDoneness}).`,
    `Saute ${veg} until ${vegDoneness}.`,
    `Cook/heat ${carb} according to package or recipe.`,
    `Plate and season to taste.`,
  ];
  return {
    id: `auto_${keyOf(title)}`,
    title,
    slotHint: slot,
    ingredients,
    steps,
    tags: ["auto", "simple"],
    timeMin: 25,
    servings: portions,
    allergens: [],
    dietTags: [],
  };
}

function buildFallbackCatalog(prefs = DEFAULT_PREFS) {
  const P = { ...DEFAULT_PREFS, ...(prefs || {}) };
  const { proteins = [], veggies = [], breads = [] } = P.meals || {};
  const portions = P.meals?.portions?.default || 4;

  const dinner = proteins.slice(0, 3).map((p, i) =>
    makeFallbackRecipe({ protein: p, veg: rotatePick(veggies, i), carb: rotatePick(breads, i), slot: "dinner", portions, prefs: P })
  );
  const lunch = proteins.slice(0, 2).map((p, i) =>
    makeFallbackRecipe({ protein: `${p} salad`, veg: rotatePick(veggies, i + 1), carb: rotatePick(breads, i + 1), slot: "lunch", portions, prefs: P })
  );
  const breakfast = [
    {
      id: "auto_eggs_toast",
      title: "Eggs & Toast",
      slotHint: "breakfast",
      ingredients: [
        { name: "egg", qty: portions, unit: "each" },
        { name: rotatePick(breads, 0), qty: portions, unit: "slice" },
        { name: "butter/oil", qty: portions * 0.5, unit: "tbsp" },
      ],
      steps: ["Cook eggs to preference. Toast bread. Serve."],
      tags: ["auto", "simple"],
      timeMin: 10,
      servings: portions,
      allergens: ["eggs", "gluten"],
      dietTags: [],
    },
    {
      id: "auto_oatmeal_fruit",
      title: "Oatmeal with Fruit",
      slotHint: "breakfast",
      ingredients: [
        { name: "rolled oats", qty: portions * 0.5, unit: "cup" },
        { name: "milk/water", qty: portions * 1.25, unit: "cup" },
        { name: "fruit (seasonal)", qty: portions, unit: "serving" },
      ],
      steps: ["Cook oats, top with fruit."],
      tags: ["auto", "simple"],
      timeMin: 12,
      servings: portions,
      allergens: [],
      dietTags: ["vegetarian"],
    },
  ];

  return { breakfast, lunch, dinner };
}

/* ───────────────── garden forecast + inventory ───────────── */

function buildForecastAvailability(forecast) {
  const map = new Map();
  if (!forecast?.timeline) return map;
  for (const bucket of forecast.timeline) {
    for (const item of bucket.items || []) {
      const nameKey = keyOf(item.crop || item.name);
      const unit = item.unit || "";
      const key = `${nameKey}:${unit}`;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push({
        date: item.date || bucket.start,
        qty: Number(item.split?.freshQty ?? item.qty ?? 0),
        unit,
        ref: item,
      });
    }
  }
  return map;
}

function unitCandidatesFor(ingName) {
  const k = keyOf(ingName);
  if (k.includes("egg")) return ["each"];
  if (k.includes("milk") || k.includes("oatmeal")) return ["quart", "cup"];
  if (k.includes("lettuce")) return ["head", "lb"];
  return ["lb", "each", "cup"];
}

function tryConvert(qty, fromUnit, toUnit) {
  if (!UnitConverter || !fromUnit || !toUnit || fromUnit === toUnit) return qty;
  try { return UnitConverter.convert(qty, fromUnit, toUnit); } catch { return qty; }
}

function allocateIngredientsForDay(ingredients, dateISO, ctx) {
  const { forecastMap, inventory = {} } = ctx;
  const needed = [];
  const usedForecast = [];
  const usedInventory = [];

  for (const ing of ingredients) {
    let remaining = Number(ing.qty || 0);
    const wantUnit = ing.unit || "";
    const nameKey = keyOf(ing.name);

    // 1) Forecast
    if (forecastMap && remaining > 0) {
      const candidates = unitCandidatesFor(ing.name);
      for (const u of [wantUnit, ...candidates]) {
        const key = `${nameKey}:${u}`;
        const slots = forecastMap.get(key) || [];
        for (const lot of slots) {
          if (dayjs(lot.date).isAfter(dayjs(dateISO))) continue;
          if (lot.qty <= 0) continue;
          // convert lot.qty (u) to wantUnit
          const lotQtyInWant = tryConvert(lot.qty, u, wantUnit || u);
          const take = Math.min(remaining, lotQtyInWant);
          if (take <= 0) continue;
          // deduct from lot in its native unit
          const backToNative = tryConvert(take, wantUnit || u, u);
          lot.qty -= backToNative;
          remaining -= take;
          usedForecast.push({ name: ing.name, qty: take, unit: wantUnit || u, source: lot.ref });
          if (remaining <= 0) break;
        }
        if (remaining <= 0) break;
      }
    }

    // 2) Inventory (shape: inventory[nameKey] = { unit, qty })
    if (remaining > 0 && inventory) {
      const inv = inventory[nameKey];
      if (inv && inv.qty > 0) {
        const invQtyInWant = tryConvert(inv.qty, inv.unit, wantUnit || inv.unit);
        const take = Math.min(remaining, invQtyInWant);
        inv.qty = Math.max(0, invQtyInWant - take); // store in want units for simplicity
        remaining -= take;
        usedInventory.push({ name: ing.name, qty: take, unit: wantUnit || inv.unit });
      }
    }

    // 3) Shopping
    if (remaining > 0) {
      needed.push({ name: ing.name, qty: remaining, unit: wantUnit || "", reason: "not_in_forecast_or_inventory" });
    }
  }

  return { needed, usedForecast, usedInventory };
}

/* ───────────────── sabbath-aware + batching ──────────────── */

function applySabbathConstraints(days, prefs, sunsetInfo = {}) {
  const sabAware = !!(prefs?.calendar?.sabbathAware);
  if (!sabAware) return days;

  const offMin = Number(prefs?.calendar?.sabbathSunsetOffsetMin || 30);
  const { fridaySunset, saturdaySunset } = sunsetInfo;
  const window = sabbathWindow(days[0]?.date || dayjs().toISOString(), offMin, fridaySunset, saturdaySunset);

  for (const d of days) {
    const date = dayjs(d.date);
    const isFri = date.day() === 5;
    const isSat = date.day() === 6;

    if (isFri && d.slots?.dinner) {
      d.slots.dinner.noCook = true;
      d.slots.dinner.notes = [...(d.slots.dinner.notes || []), `Sabbath-aware: finish cooking before ${window.start.format("HH:mm")}. Serve reheat/cold.`];
    }

    if (isSat) {
      for (const slot of SLOT_KEYS) {
        if (!d.slots[slot]) continue;
        d.slots[slot].noCook = true;
        d.slots[slot].notes = [...(d.slots[slot].notes || []), "Sabbath-aware: cold or gentle reheat only."];
      }
    }
  }
  return days;
}

function buildBatchPlan(days, prefs) {
  const enabled = !!prefs?.meals?.batchCooking?.enabled;
  if (!enabled) return null;

  const sessionDayName = (prefs?.meals?.batchCooking?.sessionDay || "Sunday").toLowerCase();
  const sessionDayIdx = ["sunday","monday","tuesday","wednesday","thursday","friday","saturday"].indexOf(sessionDayName);
  const session = days.find((d) => dayjs(d.date).day() === sessionDayIdx);
  if (!session) return null;

  // Pull suitable upcoming lunches/dinners
  const upcoming = [];
  for (const d of days) {
    for (const k of ["dinner","lunch"]) {
      const sl = d.slots[k];
      if (sl?.recipe && !sl.noCook) upcoming.push({ ...sl, date: d.date, slot: k });
    }
  }
  const maxRecipes = Number(prefs?.meals?.batchCooking?.maxRecipesPerBatch || 6);
  const selected = upcoming.slice(0, maxRecipes);

  const recipes = selected.map((s) => ({
    id: s.recipe.id,
    title: s.recipe.title,
    portions: s.portions,
    targetDate: s.date,
    slot: s.slot,
  }));

  const prepTasks = [];
  selected.forEach((s) => {
    (s.recipe.ingredients || []).forEach((ing) => {
      prepTasks.push({
        task: `Prep ${ing.name} for ${s.recipe.title}`,
        qty: ing.qty, unit: ing.unit, recipeId: s.recipe.id, due: session.date,
      });
    });
  });

  const reheatNotes = prefs?.meals?.batchCooking?.warmUpTips
    ? selected.map((s) => ({
        recipeId: s.recipe.id,
        note: `Reheat ${s.recipe.title} gently; keep veggies ${prefs.meals?.donenessHints?.vegetables || "tender-crisp"}.`,
      }))
    : [];

  // Session timing (minutes from plan anchor)
  const startMinute = (Number(prefs?.meals?.batchCooking?.sessionHour) || 14) * 60;

  return {
    sessionDate: session.date,
    startMinute,
    recipes,
    prepTasks,
    reheatNotes,
    notes: [],
  };
}

/* ─────────────── grocery merging & nutrition ─────────────── */

function mergeGroceryList(list) {
  const map = new Map();
  for (const item of list) {
    const key = `${keyOf(item.name)}:${item.unit || ""}`;
    const prev = map.get(key) || { name: item.name, qty: 0, unit: item.unit || "", reason: "meal_plan", notes: [] };
    prev.qty += Number(item.qty || 0);
    if (item.date) prev.notes.push(`${dayjs(item.date).format("YYYY-MM-DD")}${item.slot ? `:${item.slot}` : ""}`);
    map.set(key, prev);
  }
  return [...map.values()].map((x) => ({ ...x, notes: x.notes.slice(0, 5) }));
}

async function computeNutritionForPlan(days) {
  if (!NutritionService) return { totalsPerDay: [], perMeal: [], notes: ["NutritionService unavailable"] };
  const totalsPerDay = [];
  const perMeal = [];
  for (let i = 0; i < days.length; i++) {
    const d = days[i];
    let totals = { dayIndex: i, calories: 0, protein: 0, fat: 0, carbs: 0, fiber: 0, sugar: 0 };
    for (const slot of SLOT_KEYS) {
      const s = d.slots[slot];
      if (!s?.recipe) continue;
      try {
        const n = await NutritionService.estimateRecipe(s.recipe);
        perMeal.push({ dayIndex: i, slot, recipeId: s.recipe.id, recipeName: s.recipe.title, ...n });
        Object.keys(totals).forEach((k) => {
          if (k === "dayIndex") return;
          totals[k] += Number(n?.[k] || 0);
        });
      } catch (e) {}
    }
    totalsPerDay.push(totals);
  }
  return { totalsPerDay, perMeal, notes: [] };
}

/* ─────────────── labels & calendar stubs ─────────────────── */

function buildLabelStubs(days, prefs) {
  if (!prefs?.labels?.generate) return [];
  const producedOn = dayjs().format("YYYY-MM-DD");
  const out = [];
  for (const d of days) {
    for (const slot of SLOT_KEYS) {
      const s = d.slots[slot];
      if (!s?.recipe) continue;
      out.push({
        id: `label_${keyOf(s.recipe.id)}_${producedOn}`,
        recipeId: s.recipe.id,
        name: s.recipe.title,
        producedOn,
        shelfLife: prefs.labels?.defaultShelfLife || "3-5 days refrigerated",
        servings: s.portions || null,
        allergens: s.recipe.allergens || [],
        dietTags: s.recipe.dietTags || [],
        notes: s.noCook ? "No-cook / reheat" : "",
      });
    }
  }
  return out;
}

function buildCalendarEventStubs(days, prefs, anchorISO) {
  if (!prefs?.calendar?.exportEvents) return { provider: prefs.calendar?.provider || "local", exportable: false, events: [] };
  const provider = prefs.calendar?.provider || "local";
  const events = [];
  const startOfPlan = dayjs(anchorISO).startOf("day");

  for (let i = 0; i < days.length; i++) {
    const d = days[i];
    for (const slot of SLOT_KEYS) {
      const s = d.slots[slot];
      if (!s?.recipe) continue;
      const serveHour = slot === "dinner" ? 18 : slot === "lunch" ? 12 : 8;
      const start = dayjs(d.date).hour(serveHour).minute(0);
      const end = start.add(60, "minute");
      events.push({
        id: `meal_${i}_${slot}_${keyOf(s.recipe.id)}`,
        title: `${capitalize(slot)}: ${s.recipe.title}`,
        start: start.toISOString(),
        end: end.toISOString(),
        description: s.noCook ? "Sabbath-aware: cold or reheat" : "Cook/serve window",
        location: "Home",
        meta: { slot, recipeId: s.recipe.id },
      });
    }
  }
  return { provider, exportable: true, events };
}

function capitalize(s = "") { return s.charAt(0).toUpperCase() + s.slice(1); }

/* ───────────────────── main generator ────────────────────── */

/**
 * New signature (preferred):
 *   generateMealTimeline({ startDate, endDate, prefs, recipes, forecast, inventory, sunset })
 *
 * Legacy compatibility (if called with positional args via older code) is preserved
 * by detecting argument shape, but the new object signature is recommended.
 */
async function generateMealTimeline(args = {}) {
  // Legacy shim: generate(startDate, endDate, prefs)
  if (typeof args === "string") {
    const [startDate, endDate, prefs] = arguments;
    args = { startDate, endDate, prefs };
  }

  const {
    startDate,
    endDate,
    prefs = {},
    recipes = [],
    forecast = null,
    inventory = null,
    sunset = {},
  } = args;

  const P = deepMerge(DEFAULT_PREFS, prefs || {});
  const warnings = [];

  // Anchor & range
  const start = dayjs(startDate || dayjs().startOf("week"));
  const end = dayjs(endDate || start.add(6, "day"));

  // Optional user quiet windows via PreferencesService
  if (PreferencesService && P.calendar?.sabbathAware) {
    try {
      const quiet = await PreferencesService.getQuietWindows?.();
      if (quiet?.length) warnings.push("Quiet windows available via PreferencesService.");
    } catch {
      warnings.push("PreferencesService quiet windows unavailable; using local Sabbath rule.");
    }
  }

  // 1) Day skeleton
  const days = [];
  let cursor = start.startOf("day");
  while (cursor.isBefore(end) || cursor.isSame(end, "day")) {
    const weekday = cursor.format("dddd");
    const slots = {};
    for (const k of SLOT_KEYS) {
      if (P.meals?.cadence?.[k] === false) continue;
      slots[k] = {
        date: cursor.toISOString(),
        slot: k,
        recipe: null,
        portions: P.meals?.portions?.default || 4,
        ingredients: [],
        notes: [],
      };
    }
    days.push({ date: cursor.toISOString(), weekday, slots });
    cursor = cursor.add(1, "day");
  }

  // 2) Recipe catalog
  let catalog = normalizeRecipes(recipes);
  if (catalog.length === 0) {
    const fb = buildFallbackCatalog(P);
    catalog = [...fb.breakfast, ...fb.lunch, ...fb.dinner];
  }

  // 3) Slot assignment
  const bySlot = {
    breakfast: catalog.filter((r) => (r.slotHint || "").toLowerCase() === "breakfast"),
    lunch: catalog.filter((r) => (r.slotHint || "").toLowerCase() === "lunch"),
    dinner: catalog.filter((r) => (r.slotHint || "").toLowerCase() === "dinner"),
  };
  for (const sk of SLOT_KEYS) if (bySlot[sk].length === 0) bySlot[sk] = catalog;

  const pickIdx = { breakfast: 0, lunch: 0, dinner: 0 };
  for (const d of days) {
    for (const sk of SLOT_KEYS) {
      const s = d.slots[sk];
      if (!s) continue;
      const r = rotatePick(bySlot[sk], pickIdx[sk]++);
      s.recipe = r;
      s.ingredients = r.ingredients || [];
    }
  }

  // 4) Forecast + inventory allocation
  const forecastMap = P.integrateGarden ? buildForecastAvailability(forecast) : null;
  const groceryList = [];
  for (const d of days) {
    for (const sk of SLOT_KEYS) {
      const s = d.slots[sk];
      if (!s?.recipe) continue;
      const alloc = P.integrateGarden || P.integrateInventory
        ? allocateIngredientsForDay(s.ingredients, d.date, { forecastMap, inventory })
        : { needed: s.ingredients.map((i) => ({ ...i, reason: "no_integration" })), usedForecast: [], usedInventory: [] };
      s.allocated = { forecast: alloc.usedForecast, inventory: alloc.usedInventory, shopping: alloc.needed };
      groceryList.push(...alloc.needed.map((n) => ({ ...n, date: d.date, slot: sk, recipeId: s.recipe.id })));
    }
  }
  const groceryMerged = mergeGroceryList(groceryList);

  // 5) Sabbath-aware
  applySabbathConstraints(days, P, sunset);

  // 6) Batch plan
  const batchPlan = buildBatchPlan(days, P);
  const batching = batchPlan
    ? {
        enabled: true,
        sessions: [
          {
            id: `batch_${dayjs(batchPlan.sessionDate).format("YYYYMMDD")}`,
            dayIndex: days.findIndex((x) => dayjs(x.date).isSame(dayjs(batchPlan.sessionDate), "day")),
            recipeIds: batchPlan.recipes.map((r) => r.id),
            startMinute: batchPlan.startMinute,
            estimatedTotalMinutes: Math.min(240, (batchPlan.recipes.length || 1) * 40),
            notes: batchPlan.notes,
          },
        ],
      }
    : { enabled: false, sessions: [] };

  // 7) Events timeline (prep/cook/serve) + timers
  const { events, timers } = buildEventsAndTimers(days, P);

  // 8) Nutrition (best-effort)
  const nutrition = await computeNutritionForPlan(days);

  // 9) Labels
  const labels = buildLabelStubs(days, P);

  // 10) Calendar stubs
  const calendar = buildCalendarEventStubs(days, P, start.toISOString());

  // 11) Metrics
  const metrics = {
    totalPortions: days.reduce(
      (sum, d) => sum + SLOT_KEYS.reduce((acc, k) => acc + (d.slots[k]?.portions || 0), 0),
      0
    ),
    days: days.length,
  };

  // 12) Inventory delta (reserve vs missing) — best-effort using InventoryService
  let inventoryDelta = { missing: groceryMerged, toReserve: [], notes: [] };
  if (InventoryService && P.integrateInventory) {
    try {
      const toReserve = [];
      for (const d of days) {
        for (const sk of SLOT_KEYS) {
          const s = d.slots[sk];
          if (!s?.allocated?.inventory) continue;
          s.allocated.inventory.forEach((i) => toReserve.push({ name: i.name, qty: i.qty, unit: i.unit }));
        }
      }
      inventoryDelta = { missing: groceryMerged, toReserve, notes: [] };
    } catch (e) {
      inventoryDelta.notes.push(`InventoryService error: ${String(e.message || e)}`);
    }
  }

  // 13) Return enriched object (MealTimeline-shaped)
  const result = {
    range: { start: start.toISOString(), end: end.toISOString() },
    // Classic structure for backward UI pieces:
    timeline: days,
    batchPlan,
    groceryList: groceryMerged,
    metrics,

    // Enriched outputs for new UIs:
    plan: { range: { start: start.toISOString(), end: end.toISOString() }, days },
    events,
    timers,
    labels,
    inventory: inventoryDelta,
    nutrition,
    calendar,
    batching,
    meta: {
      startTime: start.startOf("day").toISOString(),
      pacing: P.pacing || "normal",
      resources: null,
      warnings,
      version: "2025-09-07.a",
    },
  };

  return result;
}

/* ─────────────── events + timers builder ──────────────── */

function buildEventsAndTimers(days, prefs) {
  const events = [];
  const timers = [];
  const makeId = (...parts) => parts.map((p) => String(p).replace(/\s+/g, "_")).join("_");

  for (let i = 0; i < days.length; i++) {
    const d = days[i];
    for (const slot of SLOT_KEYS) {
      const s = d.slots[slot];
      if (!s?.recipe) continue;

      // Simple schedule: prep -> cook -> serve (times are relative to day)
      const serveHour = slot === "dinner" ? 18 : slot === "lunch" ? 12 : 8;
      const serveStart = dayjs(d.date).hour(serveHour).minute(0);
      const cookDuration = Math.max(10, Number(s.recipe.timeMin || 30));
      const prepDuration = Math.ceil(cookDuration * 0.4);

      // If no-cook (Sabbath), compress to serve only + reheat
      const prepStart = s.noCook ? null : serveStart.subtract(prepDuration + cookDuration, "minute");
      const cookStart = s.noCook ? null : serveStart.subtract(cookDuration, "minute");

      if (!s.noCook) {
        const prepEvt = {
          id: makeId("prep", i, slot, s.recipe.id),
          dayIndex: i,
          slot,
          start: (prepStart || serveStart).toISOString(),
          durationMin: s.noCook ? 0 : prepDuration,
          type: "prep",
          title: `Prep: ${s.recipe.title}`,
          recipeId: s.recipe.id,
          recipeName: s.recipe.title,
          notes: s.notes || [],
          constraints: [],
        };
        const cookEvt = {
          id: makeId("cook", i, slot, s.recipe.id),
          dayIndex: i,
          slot,
          start: (cookStart || serveStart).toISOString(),
          durationMin: s.noCook ? 0 : cookDuration,
          type: "cook",
          title: `Cook: ${s.recipe.title}`,
          recipeId: s.recipe.id,
          recipeName: s.recipe.title,
          notes: s.notes || [],
          constraints: [],
        };
        events.push(prepEvt, cookEvt);

        if (prefs.timers?.generate) {
          timers.push(
            {
              id: makeId("timer_prep", i, slot, s.recipe.id),
              label: `Prep — ${s.recipe.title}`,
              startsAtMinute: minutesFromAnchor(prepStart, days[0].date),
              durationMinutes: prepDuration,
              voiceCue: prefs.timers?.voiceAlerts ? `Start prep for ${s.recipe.title}` : undefined,
              forEventId: prepEvt.id,
              forRecipeId: s.recipe.id,
            },
            {
              id: makeId("timer_cook", i, slot, s.recipe.id),
              label: `Cook — ${s.recipe.title}`,
              startsAtMinute: minutesFromAnchor(cookStart, days[0].date),
              durationMinutes: cookDuration,
              voiceCue: prefs.timers?.voiceAlerts ? `Start cooking ${s.recipe.title}` : undefined,
              forEventId: cookEvt.id,
              forRecipeId: s.recipe.id,
            }
          );
        }
      }

      // Serve event (always present)
      const serveEvt = {
        id: makeId("serve", i, slot, s.recipe.id),
        dayIndex: i,
        slot,
        start: serveStart.toISOString(),
        durationMin: 45,
        type: s.noCook ? "leftovers" : "serve",
        title: `${capitalize(slot)}: ${s.recipe.title}${s.noCook ? " (no-cook/reheat)" : ""}`,
        recipeId: s.recipe.id,
        recipeName: s.recipe.title,
        notes: s.noCook ? ["Sabbath-aware: cold or gentle reheat only."] : s.notes || [],
        constraints: [],
      };
      events.push(serveEvt);

      if (prefs.timers?.generate) {
        timers.push({
          id: makeId("timer_serve", i, slot, s.recipe.id),
          label: `Serve — ${s.recipe.title}`,
          startsAtMinute: minutesFromAnchor(serveStart, days[0].date),
          durationMinutes: 45,
          voiceCue: prefs.timers?.voiceAlerts ? `Meal time: ${capitalize(slot)} — ${s.recipe.title}` : undefined,
          forEventId: serveEvt.id,
          forRecipeId: s.recipe.id,
        });
      }
    }
  }

  return { events, timers };
}

function minutesFromAnchor(when, anchorISO) {
  const anchor = dayjs(anchorISO).startOf("day");
  return Math.max(0, dayjs(when).diff(anchor, "minute"));
}

/* ─────────────────────── utils ──────────────────────────── */

function deepMerge(base, extra) {
  if (!extra || typeof extra !== "object") return base;
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const [k, v] of Object.entries(extra)) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      out[k] = deepMerge(base?.[k] || {}, v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/* ───────────────────── exports ──────────────────────────── */

module.exports = {
  generateMealTimeline,
  // exposed pieces for testing / reuse
  normalizeRecipes,
  buildFallbackCatalog,
  buildForecastAvailability,
  allocateIngredientsForDay,
  applySabbathConstraints,
  buildBatchPlan,
};
