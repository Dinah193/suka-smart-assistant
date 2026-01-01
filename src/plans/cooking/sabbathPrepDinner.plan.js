// src/plans/cooking/sabbathPrepDinner.plan.js
/* eslint-disable no-console */
/**
 * sabbathPrepDinner.plan.js — Make-ahead Friday prep → warm/serve during Sabbath
 *
 * Design goals:
 * - Parameterized plan users can adapt & save as their own favorite (cloud/local)
 * - Sabbath guard: no active cooking during Sabbath window; all steps finish before start
 * - Offsets relative to sabbathStartISO (or manual offsets) for CalendarSync + SessionHUD
 * - Inventory-aware (fresh-ground grain option for “festival bread”)
 * - Emits namespaced events and provides portable payload for Save/Favorite flows
 *
 * Contract-ish:
 *  { id, templateId, x-domain, x-version, title, params, inventory, steps, timers, scheduleHints, safety, meta, toPortable(), toGroceryList() }
 */

const VERSION = "1.1.0";
const DOMAIN = "cooking";
const TEMPLATE_ID = "sabbath-prep-dinner";

/* -------------------------------- Defaults --------------------------------- */
const DEFAULTS = {
  servings: 8,
  // ISO string for local Sabbath start (e.g., Friday sunset). If not provided, offsets are relative.
  sabbathStartISO: null, // "2025-10-31T18:05:00-05:00"
  // If no sabbathStartISO, use these relative offsets from "Serve" zero point.
  offsets: {
    // negative = do before “serve” anchor time
    breadMix: "-6h",
    breadProof: "-5h15m",
    breadBake: "-4h",
    roastStart: "-5h",        // complete by sabbath start; then warm-hold
    sidesStart: "-3h",
    saladPrep: "-2h",
    dessertMake: "-7h",
    beveragePrep: "-1h30m",
    setWarmers: "-1h",        // turn on warmers/warming drawer
    tablePrep: "-1h",
    welcomeBuffer: "-20m"
  },

  // Menu toggles (select what you want; everything schedules ahead)
  menu: {
    festivalBread: true,                // freshly milled option below
    freshGrainType: "fresh-whole-wheat",// fresh-whole-wheat | fresh-whole-spelt | bread
    roast: "lamb-shoulder",             // lamb-shoulder | beef-roast | chicken-quarters | fish
    sides: ["roasted-root-veg", "seasoned-rice"], // any subset
    salad: "green-salad",               // or "cucumber-tomato"
    dessert: "fruit-crumble",           // or "honey-cake" or "none"
    beverages: ["herbal-tea","sparkling-water"]
  },

  equipment: {
    warmingDrawer: true,
    slowCooker: true,
    riceCooker: true,
    proofingBox: false,
  },

  sabbathGuard: true, // used to disable “active-cook” actions during Sabbath window
};

/* --------------------------------- Helpers ---------------------------------- */
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const grams = (n) => Math.round(Number(n) || 0);
const id = (parts) => parts.filter(Boolean).join(":");
const min = (n) => Math.round(Number(n) || 0);

function addMinutes(dt, minutes){
  const d = new Date(dt);
  d.setMinutes(d.getMinutes() + minutes);
  return d;
}
function toISO(d){ try { return new Date(d).toISOString(); } catch { return null; } }

/* Flour math for festival bread (simple 68% hydration with 2% salt) */
function breadFormula(servings, freshGrainType){
  // assume ~120g flour per person (dinner rolls/loaves for sopping sauces)
  const flour = grams(servings * 120);
  const water = grams(flour * 0.68);
  const salt  = grams(flour * 0.02);
  const yeast = grams(Math.max(2, flour * 0.009)); // instant yeast; small amount
  return { flour, water, salt, yeast, grain: freshGrainType };
}

/* ------------------------------ Inventory Build ----------------------------- */
function buildInventory(params){
  const p = { ...DEFAULTS, ...params };
  const inv = [];

  // Festival bread
  if (p.menu.festivalBread) {
    const F = breadFormula(p.servings, p.menu.freshGrainType);
    const flourName =
      F.grain === "fresh-whole-wheat" ? "Fresh-Ground Whole Wheat Flour" :
      F.grain === "fresh-whole-spelt" ? "Fresh-Ground Whole Spelt Flour" :
      "Bread Flour";
    inv.push({ id: `flour:${F.grain}`, name: flourName, qty: grams(F.flour)/1000, unit: "kg", aisle: "Baking", tags: ["baking","flour",F.grain], notes: F.grain.startsWith("fresh-") ? "Grind just before mixing." : null });
    inv.push({ id: "water", name: "Water", qty: F.water, unit: "g", aisle: "Pantry", tags: ["baking"] });
    inv.push({ id: "salt",  name: "Fine Sea Salt", qty: F.salt, unit: "g", aisle: "Spices", tags: ["baking","salt"] });
    inv.push({ id: "yeast:instant", name: "Instant Yeast", qty: F.yeast, unit: "g", aisle: "Baking", tags: ["yeast"] });
  }

  // Roast protein
  const roastUnitKg = clamp(p.servings * 0.25, 1.5, 4.5); // heuristic kg
  inv.push({
    id: `roast:${p.menu.roast}`,
    name: p.menu.roast.replace(/-/g," ").replace(/\b\w/g, c=>c.toUpperCase()),
    qty: roastUnitKg, unit: "kg", aisle: "Butcher", tags: ["roast","protein"]
  });
  inv.push({ id:"onions", name:"Onions", qty: clamp(p.servings*0.15,1,6), unit:"ea", aisle:"Produce", tags:["aromatics"]});
  inv.push({ id:"garlic", name:"Garlic", qty: clamp(p.servings*0.1,1,4), unit:"heads", aisle:"Produce", tags:["aromatics"]});
  inv.push({ id:"herbs", name:"Herbs (rosemary/thyme)", qty: 2, unit:"bunch", aisle:"Produce", tags:["herbs"]});

  // Sides
  if (p.menu.sides.includes("roasted-root-veg")){
    inv.push({ id:"root-veg", name:"Root Vegetables (carrot/parsnip/potato)", qty: clamp(p.servings*0.2,1,6), unit:"kg", aisle:"Produce", tags:["veg"]});
    inv.push({ id:"olive-oil", name:"Olive Oil", qty: min(p.servings*8), unit:"ml", aisle:"Oils", tags:["oil"]});
  }
  if (p.menu.sides.includes("seasoned-rice")){
    inv.push({ id:"rice", name:"Rice", qty: clamp(p.servings*60,200,1200), unit:"g", aisle:"Grains", tags:["rice"]});
    inv.push({ id:"broth", name:"Broth/Stock", qty: clamp(p.servings*90,300,1500), unit:"ml", aisle:"Pantry", tags:["stock"]});
  }

  // Salad
  inv.push({ id:"greens", name: p.menu.salad === "green-salad" ? "Salad Greens" : "Cucumber & Tomato", qty: clamp(p.servings*0.15,0.2,1.5), unit:"kg", aisle:"Produce", tags:["salad"]});
  inv.push({ id:"vinaigrette", name:"Vinaigrette Ingredients", qty: 1, unit:"set", aisle:"Pantry", tags:["dressing"]});

  // Dessert
  if (p.menu.dessert === "fruit-crumble"){
    inv.push({ id:"fruit", name:"Baking Fruit (apples/berries)", qty: clamp(p.servings*0.18,0.5,2), unit:"kg", aisle:"Produce", tags:["dessert"]});
    inv.push({ id:"crumble-topping", name:"Crumble Topping (oats/flour/sugar)", qty: 1, unit:"set", aisle:"Baking", tags:["dessert"]});
  } else if (p.menu.dessert === "honey-cake"){
    inv.push({ id:"honey", name:"Honey", qty: clamp(p.servings*12,120,500), unit:"g", aisle:"Baking", tags:["dessert"]});
    inv.push({ id:"cake-dry", name:"Cake Dry Mix (flour/spices)", qty: 1, unit:"set", aisle:"Baking", tags:["dessert"]});
    inv.push({ id:"eggs", name:"Eggs", qty: clamp(Math.ceil(p.servings/4),2,8), unit:"ea", aisle:"Dairy", tags:["baking"]});
  }

  // Beverages
  if (p.menu.beverages.includes("herbal-tea")) inv.push({ id:"herbal-tea", name:"Herbal Tea", qty: 1, unit:"box", aisle:"Tea", tags:["beverage"]});
  if (p.menu.beverages.includes("sparkling-water")) inv.push({ id:"sparkling-water", name:"Sparkling Water", qty: Math.ceil(p.servings/2), unit:"bottles", aisle:"Beverages", tags:["beverage"]});

  return inv;
}

/* ------------------------------ Step Builder -------------------------------- */
function stepsFor(params){
  const p = { ...DEFAULTS, ...params };
  const steps = [];
  const off = p.offsets;

  // Festival bread
  if (p.menu.festivalBread){
    const F = breadFormula(p.servings, p.menu.freshGrainType);
    steps.push({
      id:"bread.mix",
      title:"Mix Festival Bread Dough",
      offset: off.breadMix,
      duration:"20m",
      kind:"prep",
      instructions:[
        F.grain.startsWith("fresh-") ? "Grind grain just before mixing." : "Measure flour.",
        `Mix ${F.flour}g flour + ${F.water}g water; rest 20m (autolyse).`,
      ],
      reminders:[{ kind:"timer", label:"Autolyse", minutes:20 }],
    });
    steps.push({
      id:"bread.proof",
      title:"Add Salt & Yeast, Knead, Bulk Ferment",
      offset: off.breadProof,
      duration:"60m",
      kind:"ferment",
      instructions:[
        `Add ${F.salt}g salt + ${F.yeast}g instant yeast. Knead until smooth.`,
        "Bulk ferment until ~50% risen; do 2–3 folds.",
      ],
      reminders:[{ kind:"timer", label:"Bulk Check", minutes:60 }],
      signals:[{ type:"ui/progress", value:0.4 }]
    });
    steps.push({
      id:"bread.bake",
      title:"Shape, Proof, and Bake Bread",
      offset: off.breadBake,
      duration:"75m",
      kind:"bake",
      instructions:[
        "Shape loaves/rolls. Proof until puffy.",
        "Bake 20–25m at 450°F (232°C) until deep brown. Cool completely.",
      ],
      reminders:[{ kind:"timer", label:"Bake Finish", minutes:25 }],
      safety:{ ppe:["oven-mitts"] }
    });
  }

  // Roast protein (finish before Sabbath; warm-hold)
  steps.push({
    id:"roast.start",
    title:"Season & Start Roast (Finish Before Sabbath)",
    offset: off.roastStart,
    duration:"120m",
    kind:"cook",
    instructions:[
      "Season protein with salt, pepper, herbs, and aromatics.",
      "Roast/slow-cook until tender and safe temp.",
      "Move to warming drawer/slow cooker on WARM for Sabbath window.",
    ],
    schedule:[{ kind:"appliance", name:"oven", exclusive:true }],
    safety:{ ppe:["oven-mitts"] }
  });

  // Sides
  if (p.menu.sides.includes("roasted-root-veg")){
    steps.push({
      id:"sides.roots",
      title:"Roast Root Vegetables",
      offset: off.sidesStart,
      duration:"60m",
      kind:"cook",
      instructions:[
        "Cut veg, toss with oil, salt, herbs.",
        "Roast until caramelized; transfer to warming drawer or covered pan.",
      ],
      safety:{ ppe:["oven-mitts"] }
    });
  }
  if (p.menu.sides.includes("seasoned-rice")){
    steps.push({
      id:"sides.rice",
      title:"Cook Seasoned Rice",
      offset: off.sidesStart,
      duration:"45m",
      kind:"cook",
      instructions:[
        "Rinse rice. Add stock/broth and seasonings.",
        "Cook in rice cooker; hold on WARM for Sabbath.",
      ],
      schedule:[{ kind:"appliance", name:"rice-cooker", exclusive:false }]
    });
  }

  // Salad & dressing
  steps.push({
    id:"salad",
    title:"Prep Salad + Vinaigrette",
    offset: off.saladPrep,
    duration:"20m",
    kind:"prep",
    instructions:[
      "Wash and prep greens/veg. Shake vinaigrette in jar.",
      "Refrigerate; toss right before serving.",
    ]
  });

  // Dessert
  if (p.menu.dessert === "fruit-crumble"){
    steps.push({
      id:"dessert.crumble",
      title:"Assemble Fruit Crumble",
      offset: off.dessertMake,
      duration:"25m",
      kind:"prep",
      instructions:[
        "Slice fruit; toss with sugar/lemon/spices.",
        "Top with crumble. Bake now or pre-bake and rewarm on LOW.",
      ],
      safety:{ ppe:["oven-mitts"] }
    });
  } else if (p.menu.dessert === "honey-cake"){
    steps.push({
      id:"dessert.honey-cake",
      title:"Bake Honey Cake",
      offset: off.dessertMake,
      duration:"55m",
      kind:"bake",
      instructions:[
        "Mix wet + dry; bake until tester clean.",
        "Cool fully; serve room temp.",
      ],
      safety:{ ppe:["oven-mitts"] }
    });
  }

  // Warmers & table
  steps.push({
    id:"warmers.set",
    title:"Set Warmers/Warming Drawer",
    offset: off.setWarmers,
    duration:"5m",
    kind:"setup",
    instructions:[
      "Confirm warm-hold devices are on LOW/WARM.",
      "Cover foods to avoid drying; set out safe serving utensils.",
    ]
  });

  steps.push({
    id:"table.prep",
    title:"Prepare Table & Serving",
    offset: off.tablePrep,
    duration:"20m",
    kind:"setup",
    instructions:[
      "Set table, water, beverages, serving spoons, trivets.",
      "Place finished dishes in warming/holding as needed.",
    ]
  });

  steps.push({
    id:"welcome.buffer",
    title:"Arrival/Wind-down Buffer",
    offset: off.welcomeBuffer,
    duration:"20m",
    kind:"buffer",
    instructions:["Take a breath. Everything is prepped—enjoy the peace."],
    signals:[{ type:"ui/progress", value:1 }]
  });

  return steps;
}

/* ------------------------------- Timers ------------------------------------- */
function timersFor(params){
  const p = { ...DEFAULTS, ...params };
  const timers = [];

  if (p.menu.festivalBread){
    timers.push({ id:"bread.autolyse", label:"Autolyse", minutes:20 });
    timers.push({ id:"bread.bake.finish", label:"Bread Bake Finish", minutes:25 });
  }
  timers.push({ id:"roast.check", label:"Roast Check", minutes:90 });
  if (p.menu.sides.includes("roasted-root-veg")) timers.push({ id:"veg.roast", label:"Veg Roast", minutes:45 });
  if (p.menu.sides.includes("seasoned-rice")) timers.push({ id:"rice.finish", label:"Rice Finish", minutes:30 });

  return timers;
}

/* ---------------------------- Schedule Hints -------------------------------- */
function scheduleHintsFor(params){
  const p = { ...DEFAULTS, ...params };
  const hints = [
    { kind:"withhold", reason:"sabbath-no-cook", window:"from-start", disabled: !p.sabbathGuard },
    { kind:"appliance", name:"oven", window:"3h", exclusive:true },
    { kind:"biohazard", rule:"meat-raw-cross-contamination" }
  ];

  // If sabbathStartISO is provided, add explicit no-active-cook period
  if (p.sabbathStartISO) {
    const start = new Date(p.sabbathStartISO);
    // 25 hours by convention for safety buffer; adjust as needed by the household
    const end = addMinutes(start, 25 * 60);
    hints.push({ kind:"withholdAbsolute", start: toISO(start), end: toISO(end), reason:"sabbath-period" });
  }
  return hints;
}

/* ------------------------------- Factory ------------------------------------ */
export function createSabbathPrepDinnerPlan(params = {}){
  const p = { ...DEFAULTS, ...params };

  const planId = id(["cookplan", TEMPLATE_ID, `${p.servings}p`, p.menu.roast]);
  const plan = {
    id: planId,
    templateId: TEMPLATE_ID,
    "x-domain": DOMAIN,
    "x-version": VERSION,
    title: "Sabbath Prep Dinner — Make Ahead & Warm-Hold",
    description: "Friday prep flow that completes cooking before Sabbath; warm-hold and serve peacefully.",
    tags: ["sabbath","make-ahead","dinner","warm-hold","whole-grain"],

    params: p,
    resources: {
      equipment: [
        p.equipment.warmingDrawer && "Warming Drawer",
        p.equipment.slowCooker && "Slow Cooker",
        p.equipment.riceCooker && "Rice Cooker",
        p.equipment.proofingBox && "Proofing Box",
        "Oven", "Mixing Bowls", "Sheet Pans", "Dutch Oven (optional)"
      ].filter(Boolean),
    },

    inventory: buildInventory(p),
    steps: stepsFor(p),
    timers: timersFor(p),
    scheduleHints: scheduleHintsFor(p),
    safety: { ppe:["oven-mitts"], hygiene:["wash-hands-after-raw-meat"] },

    meta: {
      savable: true,
      favoriteable: true,
      authoring: { canFork: true, forkLabel: "Save your Sabbath Dinner plan" },
      share: { portable: true },
    },

    toGroceryList(){
      return this.inventory.map(it => ({ id: it.id, name: it.name, qty: it.qty, unit: it.unit, aisle: it.aisle, tags: it.tags }));
    },

    toPortable(){
      return {
        schema: "urn:suka:portable:workplan:1",
        domain: this["x-domain"],
        templateId: this.templateId,
        title: this.title,
        description: this.description,
        params: this.params,
        version: this["x-version"],
        createdAt: new Date().toISOString(),
        inventory: this.inventory,
        steps: this.steps,
        timers: this.timers,
        tags: this.tags,
      };
    }
  };

  try {
    const bus = (typeof window !== "undefined" && window.__suka_eventBus__) || null;
    bus?.emit?.("workplan.created", { domain: DOMAIN, templateId: TEMPLATE_ID, id: plan.id, params: p });
  } catch {}

  return plan;
}

/* ---------------------------- Template Strategy ----------------------------- */
/** Use external library if present; otherwise fall back to in-file factory */
export async function getSabbathPrepDinnerPlan(params = {}){
  try {
    const T = await import(/* @vite-ignore */ "@/libraries/CookPlanTemplates");
    const api = T?.default ?? T;
    if (api?.get) {
      const external = await api.get(TEMPLATE_ID, params);
      if (external) return external;
    }
  } catch { /* no external library yet */ }
  return createSabbathPrepDinnerPlan(params);
}

/* ------------------------------- Default Export ----------------------------- */
export default {
  id: TEMPLATE_ID,
  domain: DOMAIN,
  version: VERSION,
  defaults: DEFAULTS,
  create: createSabbathPrepDinnerPlan,
  get: getSabbathPrepDinnerPlan,
};
