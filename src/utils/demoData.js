// src/utils/demoData.js

/**
 * Suka Demo Data
 * - Dynamic, seedable demo content for Recipes, Meal Plan, Inventory, Cleaning, Garden.
 * - Time-relative (uses the current local date), Moedim/feast-aware hints, pantry-first bias.
 * - Automation-aware: can listen to 'automation:intent' for 'demo/load' or 'demo/reset'.
 *
 * Public API:
 *   createDemoState(opts?)           -> { recipes, inventory, mealPlan, cleaning, garden, vision, budget }
 *   seedStores(state?)               -> seeds any available stores (lazy import, safe)
 *   attachDemoIntents()              -> installs listeners for demo/load and demo/reset
 *   loadDemoNow(opts?)               -> convenience: create + seed + emit onboarding events
 *
 * No external deps. Safe to import anywhere.
 */

const DEFAULT_SEED = "suka::demo::v1";

/* -------------------------------------------------------------------------- */
/* Utilities                                                                  */
/* -------------------------------------------------------------------------- */

export function mulberry32(seed) {
  let a = xmur3a(seed);
  return function () {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function xmur3a(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return function () {
    h += h << 13; h ^= h >>> 7;
    h += h << 3;  h ^= h >>> 17;
    h += h << 5;
    return h >>> 0;
  };
}
function pick(rand, arr) {
  return arr[Math.floor(rand() * arr.length)];
}
function id(prefix = "id") {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}`;
}
function todayLocal() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}
function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
function startOfWeek(d, weekStartsOn = 0) {
  const x = new Date(d);
  const day = x.getDay();
  const diff = (day < weekStartsOn ? 7 : 0) + day - weekStartsOn;
  x.setDate(x.getDate() - diff);
  x.setHours(0, 0, 0, 0);
  return x;
}
function isoDate(d) {
  const x = new Date(d);
  x.setMinutes(x.getMinutes() - x.getTimezoneOffset());
  return x.toISOString().slice(0, 10);
}
function hour(d, h, m = 0) {
  const x = new Date(d);
  x.setHours(h, m, 0, 0);
  return x;
}

/* -------------------------------------------------------------------------- */
/* Vision (Household Profile)                                                 */
/* -------------------------------------------------------------------------- */

function buildVision(rand, overrides = {}) {
  const presets = {
    mode: ["Balanced Hybrid", "Pantry-First"],
    goals: [
      "Cook 5 nights; dehydrate garden surplus weekly; keep cleaning ≤ 90 min.",
      "Low-sugar, high-protein; quick breakfasts.",
    ],
    constraints: ["Small kitchen, 2 burners only", "Minimal dishes; 1 pan preferred"],
    dietary: ["Torah Dietary Compliant", "Low Sugar"],
    weeklyHrs: "5",
    budget: "$200",
    mealRhythm: {
      kind: "16:8",
      window: { fastHours: 16, eatHours: 8 },
      batchNights: ["Sun", "Wed"],
      feastHints: ["Erev Shabbat — larger prep Thu/Fri", "Moedim awareness"],
    },
  };
  return { ...presets, ...overrides };
}

/* -------------------------------------------------------------------------- */
/* Recipes                                                                    */
/* -------------------------------------------------------------------------- */

function buildRecipes(rand) {
  const sources = ["scan", "paste", "typed"];
  const items = [
    {
      title: "Sheet Pan Za’atar Chicken & Veg",
      url: "https://example.com/zaatar-sheet-pan",
      timeMins: 35,
      tags: ["1-pan", "pantry-first", "weeknight"],
      servings: 4,
      image: "/assets/demo/zaatar.jpg",
      source: pick(rand, sources),
      ingredients: [
        "6 chicken thighs",
        "2 tbsp za’atar",
        "2 tbsp olive oil",
        "1 red onion, wedges",
        "2 zucchini, thick coins",
        "Salt, pepper",
      ],
      steps: [
        "Heat oven to 425°F / 220°C.",
        "Toss chicken + veg with oil, za’atar, S&P.",
        "Roast 25–30 min; finish 2–3 min broil.",
      ],
    },
    {
      title: "Lentil & Herb Mujadara (brown rice mix)",
      url: "https://example.com/mujadara",
      timeMins: 45,
      tags: ["vegan", "cheap", "batchable"],
      servings: 6,
      image: "/assets/demo/mujadara.jpg",
      source: pick(rand, sources),
      ingredients: [
        "1 cup brown lentils",
        "1 cup brown rice",
        "2 onions, sliced",
        "3 tbsp olive oil",
        "1 tsp cumin, 1 tsp coriander",
        "Salt",
      ],
      steps: [
        "Caramelize onions 15–20 min.",
        "Simmer rice + lentils together 30–35 min.",
        "Fold onions + herbs; season.",
      ],
    },
    {
      title: "Garden Zoodle Bowls w/ Tahini",
      url: "https://example.com/zoodle-tahini",
      timeMins: 20,
      tags: ["garden-heavy", "low-carb", "fast"],
      servings: 2,
      image: "/assets/demo/zoodle.jpg",
      source: pick(rand, sources),
      ingredients: [
        "2 zucchini, spiralized",
        "1/3 cup tahini",
        "1 lemon, juiced",
        "1 garlic clove, grated",
        "Water to thin, salt",
      ],
      steps: ["Whisk tahini/lemon/garlic; thin w/ water.", "Toss with zoodles; top with herbs/seed mix."],
    },
  ];

  return items.map((r) => ({ id: id("rec"), ...r, createdAt: Date.now() - Math.floor(rand() * 864e5) }));
}

/* -------------------------------------------------------------------------- */
/* Inventory                                                                  */
/* -------------------------------------------------------------------------- */

function buildInventory(rand) {
  const items = [
    { name: "Olive oil", qty: "750 ml", area: "Pantry", low: true },
    { name: "Brown rice", qty: "2 lb", area: "Pantry", low: false },
    { name: "Chicken thighs", qty: "2 lb", area: "Freezer", low: false },
    { name: "Lentils", qty: "1 lb", area: "Pantry", low: true },
    { name: "Zucchini", qty: "6", area: "Garden", low: false },
    { name: "Onions", qty: "4", area: "Pantry", low: false },
    { name: "Za’atar", qty: "1 jar", area: "Pantry", low: false },
  ];
  return items.map((x) => ({
    id: id("inv"),
    ...x,
    updatedAt: Date.now() - Math.floor(rand() * 6048e5),
  }));
}

/* -------------------------------------------------------------------------- */
/* Meal Rhythm & Week Plan                                                    */
/* -------------------------------------------------------------------------- */

function buildMealRhythm(vision) {
  const d = todayLocal();
  const start = startOfWeek(d, 0); // Sunday
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const batchNights = vision.mealRhythm?.batchNights || ["Sun", "Wed"];
  const rhythm = {
    kind: vision.mealRhythm?.kind || "16:8",
    window: vision.mealRhythm?.window || { fastHours: 16, eatHours: 8 },
    batchNights,
    weekStart: isoDate(start),
    notes: ["Prefer pantry-first recipes early week", ...(vision.mealRhythm?.feastHints || [])],
  };
  const slots = days.map((d, idx) => {
    const isBatch = batchNights.includes(d);
    const isShabbat = d === "Fri";
    const note = isShabbat ? "Erev Shabbat: prep larger meal" : isBatch ? "Batch cook base for leftovers" : "Light";
    return { day: d, date: isoDate(addDays(start, idx)), isBatch, isShabbat, note };
  });
  return { rhythm, slots };
}

function buildMealPlan(rand, recipes, rhythmSlots) {
  // Simple assignment: batch nights get Mujadara/Sheet Pan, others get leftovers or quick bowls
  const byTitle = Object.fromEntries(recipes.map((r) => [r.title, r]));
  const choose = (title) => {
    const r = byTitle[title];
    return r ? { recipeId: r.id, title: r.title, timeMins: r.timeMins } : null;
  };
  const plan = rhythmSlots.map((slot) => {
    let pickTitle = slot.isBatch
      ? (rand() > 0.5 ? "Lentil & Herb Mujadara (brown rice mix)" : "Sheet Pan Za’atar Chicken & Veg")
      : (rand() > 0.5 ? "Garden Zoodle Bowls w/ Tahini" : "Leftovers (batch)");
    const item = choose(pickTitle);
    return {
      id: id("meal"),
      date: slot.date,
      day: slot.day,
      slot: "dinner",
      item,
      note: slot.note,
    };
  });
  return { week: { items: plan, createdAt: Date.now() } };
}

/* -------------------------------------------------------------------------- */
/* Cleaning                                                                   */
/* -------------------------------------------------------------------------- */

function buildCleaning(rand) {
  const zones = [
    { name: "Kitchen", tasks: ["Counters", "Sink", "Microwave", "Floors", "Trash"] },
    { name: "Living Area", tasks: ["Dust", "Surfaces", "Vacuum", "Declutter"] },
    { name: "Bath", tasks: ["Toilet", "Sink", "Mirror", "Shower"] },
    { name: "Laundry", tasks: ["Wash", "Dry", "Fold"] },
  ];
  const today = pick(rand, zones);
  const timebox = 90;
  return {
    today: {
      id: id("clean"),
      startedAt: null,
      timeboxMins: timebox,
      tasks: today.tasks.map((t) => ({ id: id("task"), title: t, done: rand() > 0.6 ? true : false })),
      zone: today.name,
    },
    schedule: zones.map((z, idx) => ({
      id: id("cz"),
      day: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sun", "Sat"][idx % 7],
      zone: z.name,
    })),
  };
}

/* -------------------------------------------------------------------------- */
/* Garden                                                                     */
/* -------------------------------------------------------------------------- */

function buildGarden(rand) {
  const zones = ["Front Beds", "Back Garden", "Planters"];
  const tasks = [
    { title: "Harvest zucchini", zone: "Back Garden" },
    { title: "Check irrigation", zone: "Front Beds" },
    { title: "Turn compost", zone: "Back Garden" },
    { title: "Start herb cuttings", zone: "Planters" },
  ];
  return {
    zones,
    tasks: tasks.map((t) => ({ id: id("g"), ...t, done: rand() > 0.7 })),
  };
}

/* -------------------------------------------------------------------------- */
/* Budget (light demo)                                                        */
/* -------------------------------------------------------------------------- */

function buildBudget(rand) {
  const cats = [
    { name: "Groceries", weekly: 200 },
    { name: "Household", weekly: 40 },
    { name: "Garden", weekly: 25 },
  ];
  const spend = cats.map((c) => ({
    id: id("b"),
    cat: c.name,
    amount: Math.round((0.3 + rand() * 0.6) * c.weekly),
  }));
  return { categories: cats, thisWeek: spend };
}

/* -------------------------------------------------------------------------- */
/* Main builder                                                               */
/* -------------------------------------------------------------------------- */

export function createDemoState(opts = {}) {
  const seed = String(opts.seed || DEFAULT_SEED);
  const rand = mulberry32(seed);
  const vision = buildVision(rand, opts.vision || {});
  const recipes = buildRecipes(rand);
  const inventory = buildInventory(rand);
  const { rhythm, slots } = buildMealRhythm(vision);
  const mealPlan = buildMealPlan(rand, recipes, slots);
  const cleaning = buildCleaning(rand);
  const garden = buildGarden(rand);
  const budget = buildBudget(rand);

  return {
    seed,
    createdAt: Date.now(),
    vision,
    recipes,
    inventory,
    mealPlan: { ...mealPlan, rhythm },
    cleaning,
    garden,
    budget,
  };
}

/* -------------------------------------------------------------------------- */
/* Store seeding (defensive, lazy)                                            */
/* -------------------------------------------------------------------------- */

export async function seedStores(state = createDemoState()) {
  const seeded = { ...state };
  // VisionContext
  try {
    const mod = await import(/* @vite-ignore */ "@/context/VisionContext").catch(() => null);
    const setOptions = mod?.useVision?.getState ? mod.useVision.getState().setOptions : mod?.setOptions;
    if (typeof setOptions === "function") {
      setOptions((prev) => ({ ...(prev || {}), ...seeded.vision, collapsedHome: true }));
      window.dispatchEvent(new CustomEvent("vision:updated"));
    }
  } catch {}

  // Recipes
  try {
    const mod = await import(/* @vite-ignore */ "@/store/RecipeStore").catch(() => null);
    const useRecipes = mod?.useRecipes;
    if (useRecipes?.setState) {
      useRecipes.setState({ items: seeded.recipes });
      window.dispatchEvent(new CustomEvent("recipes:imported", { detail: { count: seeded.recipes.length } }));
    }
  } catch {}

  // Meal Plan
  try {
    const mod = await import(/* @vite-ignore */ "@/store/MealPlanStore").catch(() => null);
    const useMealPlan = mod?.useMealPlan;
    if (useMealPlan?.setState) {
      useMealPlan.setState({ week: seeded.mealPlan.week, rhythm: seeded.mealPlan.rhythm });
      window.dispatchEvent(new CustomEvent("mealPlan:opened"));
      window.dispatchEvent(new CustomEvent("mealPlan:rhythm:created"));
    }
  } catch {}

  // Cleaning
  try {
    const mod = await import(/* @vite-ignore */ "@/store/CleaningStore").catch(() => null);
    const useCleaning = mod?.useCleaning;
    if (useCleaning?.setState) {
      useCleaning.setState({ today: seeded.cleaning.today, schedule: seeded.cleaning.schedule });
      if (seeded.cleaning.today.tasks?.length) window.dispatchEvent(new CustomEvent("cleaning:generated"));
    }
  } catch {}

  // Inventory
  try {
    const mod = await import(/* @vite-ignore */ "@/store/InventoryStore").catch(() => null);
    const useInventory = mod?.useInventory;
    if (useInventory?.setState) {
      useInventory.setState({ all: seeded.inventory, low: seeded.inventory.filter((x) => x.low) });
      if (seeded.inventory.length) window.dispatchEvent(new CustomEvent("inventory:item:added"));
    }
  } catch {}

  return seeded;
}

/* -------------------------------------------------------------------------- */
/* Automation intents                                                         */
/* -------------------------------------------------------------------------- */

export function attachDemoIntents() {
  const handler = async (e) => {
    const { intent, seed, vision } = e.detail || {};
    if (intent === "demo/load") {
      const state = createDemoState({ seed, vision });
      await seedStores(state);
      // nudge onboarding
      window.dispatchEvent(new CustomEvent("onboarding:step:done", { detail: { id: "household_profile" } }));
      return;
    }
    if (intent === "demo/reset") {
      try {
        const clear = (s) => s?.setState?.(() => ({}));
        const R = await import(/* @vite-ignore */ "@/store/RecipeStore").catch(() => null);
        const M = await import(/* @vite-ignore */ "@/store/MealPlanStore").catch(() => null);
        const C = await import(/* @vite-ignore */ "@/store/CleaningStore").catch(() => null);
        const I = await import(/* @vite-ignore */ "@/store/InventoryStore").catch(() => null);
        clear(R?.useRecipes);
        clear(M?.useMealPlan);
        clear(C?.useCleaning);
        clear(I?.useInventory);
      } catch {}
      window.dispatchEvent(new CustomEvent("onboarding:reset"));
    }
  };
  window.addEventListener("automation:intent", handler);
  return () => window.removeEventListener("automation:intent", handler);
}

/* -------------------------------------------------------------------------- */
/* One-shot convenience                                                       */
/* -------------------------------------------------------------------------- */

export async function loadDemoNow(opts) {
  const st = createDemoState(opts);
  await seedStores(st);
  return st;
}

/* -------------------------------------------------------------------------- */
/* Example: lightweight fixtures for unit tests                               */
/* -------------------------------------------------------------------------- */

export const Demo = {
  createDemoState,
  seedStores,
  attachDemoIntents,
  loadDemoNow,
};

export default Demo;
