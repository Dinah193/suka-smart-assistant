// src/plans/cleaning/deepCleanKitchen.plan.js
/* eslint-disable no-console */
/**
 * deepCleanKitchen.plan.js — Room-by-room deep clean for the kitchen
 *
 * Goals
 * - Dynamic parameters (size, grease level, allergies, Sabbath/quiet hours, eco mode)
 * - Clear phases like well-designed cleaning apps (Prep → High → Mid → Low → Floors → Reset)
 * - Consumables/equipment list for inventory + grocery list
 * - Timers & offsets for SessionHUD / MultiTimer
 * - Namespaced events + portable saving so users can FAVORITE or fork their own plan
 *
 * Contract
 *  { id, templateId, x-domain, x-version, title, params, inventory, steps, timers,
 *    scheduleHints, safety, meta, toPortable(), toGroceryList() }
 */

const VERSION = "1.0.0";
const DOMAIN = "cleaning";
const TEMPLATE_ID = "deep-clean-kitchen";

/* -------------------------------- Defaults --------------------------------- */
const DEFAULTS = {
  home: { occupants: 4, pets: 1 },
  kitchen: {
    size: "medium",          // small | medium | large
    greaseLevel: "medium",   // low | medium | high
    hasRangeHood: true,
    hasDishwasher: true,
    hasOvenSelfClean: false,
    materialCounters: "quartz", // quartz | granite | laminate | butcher-block | stainless
    floorType: "tile",       // tile | vinyl | wood | stone
  },
  preferences: {
    ecoMode: true,                 // bias to mild products / microfiber / steam
    fragranceFree: true,           // swap chemicals for hypoallergenic where possible
    sabbathGuard: false,           // disallow cleaning across the Sabbath window
    quietHours: null,              // e.g. { startISO, endISO } to avoid loud tasks
  },
  schedule: {
    // Offsets relative to 'Start' anchor; negative means "start-of-session + offset"
    prep: "-0m",
    declutter: "-0m",
    degrease: "+15m",
    appliances: "+40m",
    cabinets: "+75m",
    backsplash: "+95m",
    counters: "+110m",
    sink: "+125m",
    floors: "+140m",
    reset: "+170m",
  },
};

/* --------------------------------- Helpers ---------------------------------- */
const id = (parts) => parts.filter(Boolean).join(":");
const clamp = (n,a,b)=>Math.max(a,Math.min(b,n));
const grams = (n)=>Math.round(Number(n)||0);
const ml = (n)=>Math.round(Number(n)||0);
const minutes = (size, base) => {
  const scale = size === "small" ? 0.8 : size === "large" ? 1.3 : 1.0;
  return Math.round(base * scale);
};
const toISO = (d)=>{ try{ return new Date(d).toISOString(); }catch{ return null; } };

/* ------------------------------ Inventory Build ----------------------------- */
/**
 * Consumables + tools (by preference & materials)
 * Items are shaped to work with InventoryMonitor and grocery list builder.
 */
function buildInventory(params){
  const p = { ...DEFAULTS, ...params };
  const inv = [];
  const mat = p.kitchen.materialCounters;
  const floor = p.kitchen.floorType;

  // Core consumables
  inv.push({ id:"trash-bags", name:"Trash Bags", qty:1, unit:"roll", aisle:"Household", tags:["trash"] });
  inv.push({ id:"microfiber-10", name:"Microfiber Cloths", qty:10, unit:"ea", aisle:"Cleaning", tags:["cloths"] });
  inv.push({ id:"scrub-pads", name:"Non-scratch Scrub Pads", qty:4, unit:"ea", aisle:"Cleaning", tags:["scrub"] });

  // Degreaser / general cleaner
  if (p.preferences.ecoMode){
    inv.push({ id:"degreaser-eco", name:"Plant-based Degreaser", qty: ml(500), unit:"ml", aisle:"Cleaning", tags:["degreaser","eco"] });
    inv.push({ id:"all-purpose-eco", name:"All-Purpose Cleaner (Fragrance Free)", qty: ml(750), unit:"ml", aisle:"Cleaning", tags:["surface","eco","fragrance-free"] });
  } else {
    inv.push({ id:"degreaser", name:"Kitchen Degreaser", qty: ml(500), unit:"ml", aisle:"Cleaning", tags:["degreaser"] });
    inv.push({ id:"all-purpose", name:"All-Purpose Cleaner", qty: ml(750), unit:"ml", aisle:"Cleaning", tags:["surface"] });
  }

  // Counter-safe
  if (mat === "granite" || mat === "stone") {
    inv.push({ id:"stone-cleaner", name:"Stone/Granite Cleaner (pH neutral)", qty: ml(650), unit:"ml", aisle:"Cleaning", tags:["counter","stone"] });
  } else if (mat === "butcher-block") {
    inv.push({ id:"wood-soap", name:"Wood Soap", qty: ml(350), unit:"ml", aisle:"Cleaning", tags:["wood"] });
    inv.push({ id:"mineral-oil", name:"Food-Grade Mineral Oil", qty: ml(250), unit:"ml", aisle:"Kitchen", tags:["conditioner"] });
  } else if (mat === "stainless") {
    inv.push({ id:"stainless-spray", name:"Stainless Steel Cleaner", qty: ml(300), unit:"ml", aisle:"Cleaning", tags:["stainless"] });
  }

  // Appliances
  inv.push({ id:"oven-cleaner", name: p.kitchen.hasOvenSelfClean ? "Oven-Liner Replacement (optional)" : "Oven Cleaner (fume-free)", qty:1, unit:"ea", aisle:"Cleaning", tags:["oven"] });
  inv.push({ id:"descaler", name:"Descaler (kettle/coffee)", qty:1, unit:"ea", aisle:"Cleaning", tags:["descale"] });
  inv.push({ id:"dishwasher-cleaner", name:"Dishwasher Cleaner Tabs", qty:1, unit:"pack", aisle:"Cleaning", tags:["dishwasher"] });

  // Floor care
  if (floor === "wood") inv.push({ id:"wood-floor-cleaner", name:"Wood Floor Cleaner", qty: ml(1000), unit:"ml", aisle:"Cleaning", tags:["floor","wood"] });
  else if (floor === "stone") inv.push({ id:"stone-floor-cleaner", name:"Stone/Tile Neutral Cleaner", qty: ml(1000), unit:"ml", aisle:"Cleaning", tags:["floor","stone"] });
  else inv.push({ id:"tile-vinyl-cleaner", name:"Tile/Vinyl Floor Cleaner", qty: ml(1000), unit:"ml", aisle:"Cleaning", tags:["floor"] });

  // PPE
  inv.push({ id:"gloves-nitrile", name:"Nitrile Gloves", qty:1, unit:"box", aisle:"Health", tags:["ppe"] });

  return inv;
}

/* --------------------------------- Steps ------------------------------------ */
/**
 * Steps are organized by vertical surfaces → appliances → horizontals → floors → reset.
 * Each step has an offset, duration, kind, instructions, and optional reminders & signals.
 */
function stepsFor(params){
  const p = { ...DEFAULTS, ...params };
  const s = p.schedule;
  const size = p.kitchen.size;
  const grease = p.kitchen.greaseLevel;

  const degreaseMinutes = minutes(size, grease === "high" ? 45 : grease === "medium" ? 30 : 20);

  const steps = [
    {
      id:"prep.stage",
      title:"Stage Tools & Open Windows",
      offset: s.prep, duration:"8m", kind:"setup",
      instructions:[
        "Open window / start vent. Lay out microfiber, pads, gloves.",
        "Fill two buckets: soapy (warm) + rinse.",
        "Start dishwasher with cleaner tab (empty) if due."
      ],
    },
    {
      id:"declutter",
      title:"Declutter Countertops",
      offset: s.declutter, duration: minutes(size, 12) + "m", kind:"prep",
      instructions:[
        "Collect dishes to sink or dishwasher rack.",
        "Put away small appliances not in daily use.",
        "Empty trash and replace liner."
      ],
    },
    {
      id:"high.touch.degrease",
      title:"High Touch Degrease (Hood, Handles, Switches)",
      offset: s.degrease, duration: degreaseMinutes + "m", kind:"wipe",
      instructions:[
        "Spray degreaser on hood baffle/underside; soak 3–5 min.",
        "Wipe cabinet pulls, fridge/dishwasher handles, light switches.",
        "Rinse cloth frequently; swap when saturated."
      ],
      reminders:[
        { kind:"timer", label:"Baffle Soak", minutes:5 }
      ],
      signals:[{ type:"ui/progress", value: 0.25 }]
    },
    {
      id:"appliances.exterior",
      title:"Appliances — Exterior Pass",
      offset: s.appliances, duration: minutes(size, 20) + "m", kind:"wipe",
      instructions:[
        "Fridge doors & edges; microwave face; dishwasher face.",
        "For stainless, spray on cloth (not directly), wipe with grain."
      ],
    },
    {
      id:"appliances.interior",
      title:"Appliances — Interior Quick Clean",
      offset: s.appliances, duration: minutes(size, 25) + "m", kind:"detail",
      instructions:[
        "Microwave: steam bowl 3–4m, wipe fully.",
        p.kitchen.hasDishwasher ? "Dishwasher filter rinse; run cleaner cycle if due." : null,
        "Coffee/Kettle: run descaler. Rinse per label."
      ].filter(Boolean),
      reminders:[{ kind:"timer", label:"Steam Bowl", minutes:4 }]
    },
    {
      id:"cabinets.doors",
      title:"Cabinet Doors & Backsplash",
      offset: s.cabinets, duration: minutes(size, 25) + "m", kind:"wipe",
      instructions:[
        "Top→bottom pass. Use degreaser for splatter zones near cooktop.",
        "Backsplash: spray lightly; agitate grout if tile."
      ],
    },
    {
      id:"counters.sanitize",
      title:"Countertops — Safe Cleaner for Material",
      offset: s.counters, duration: minutes(size, 18) + "m", kind:"sanitize",
      instructions:[
        "Clear remaining items. Spray appropriate cleaner:",
        materialHint(p.kitchen.materialCounters),
        "Buff dry with fresh microfiber for streak-free finish."
      ],
      signals:[{ type:"ui/progress", value: 0.65 }]
    },
    {
      id:"sink.polish",
      title:"Sink & Faucet Polish",
      offset: s.sink, duration: minutes(size, 12) + "m", kind:"detail",
      instructions:[
        "Scrub basin with non-scratch pad and cleaner.",
        "Rinse; wipe dry. Polish faucet. Disinfect drain ring."
      ],
    },
    {
      id:"floors.end",
      title:"Sweep/Vac → Mop Floors",
      offset: s.floors, duration: minutes(size, 25) + "m", kind:"floor",
      instructions:[
        "Sweep or vacuum all edges first, then center.",
        floorHint(p.kitchen.floorType),
      ],
      signals:[{ type:"ui/progress", value: 0.9 }]
    },
    {
      id:"reset.stage",
      title:"Reset: Put Back, Stage Tomorrow",
      offset: s.reset, duration:"10m", kind:"reset",
      instructions:[
        "Return appliances, refill paper towels/soap.",
        "Start laundry load for cloths. Final walkthrough."
      ],
      signals:[{ type:"ui/progress", value: 1 }]
    }
  ];

  // Optional: Oven (self-clean vs manual)
  steps.splice(3, 0, p.kitchen.hasOvenSelfClean ? {
    id:"oven.selfclean",
    title:"Oven Self-Clean Prep",
    offset: "+35m",
    duration:"5m",
    kind:"appliance",
    instructions:[
      "Remove racks and liners. Start self-clean (ensure ventilation).",
      "Schedule wipe-out tomorrow when cooled."
    ],
    safety:{ ventilation:true, ppe:["gloves-nitrile"] }
  } : {
    id:"oven.manual",
    title:"Oven Manual Clean (Fume-Free)",
    offset: "+35m",
    duration: minutes(size, 20) + "m",
    kind:"appliance",
    instructions:[
      "Apply fume-free oven cleaner. Close door to dwell.",
      "Wipe out per label; rinse cloths thoroughly."
    ],
    safety:{ ppe:["gloves-nitrile"] },
    reminders:[{ kind:"timer", label:"Oven Dwell", minutes:20 }]
  });

  return steps;
}

function materialHint(mat){
  switch(mat){
    case "granite": case "stone": return "Use pH-neutral stone cleaner; avoid acids/ammonia.";
    case "butcher-block": return "Use wood soap; dry fully. Condition with mineral oil monthly.";
    case "stainless": return "Use stainless spray; wipe with grain; finish dry.";
    default: return "Use all-purpose cleaner safe for sealed surfaces.";
  }
}
function floorHint(type){
  switch(type){
    case "wood": return "Microfiber damp mop with wood cleaner; avoid standing water.";
    case "stone": return "Neutral cleaner; wring mop very well; dry any puddles.";
    default: return "Use tile/vinyl cleaner; two-bucket method recommended.";
  }
}

/* -------------------------------- Timers ------------------------------------ */
function timersFor(params){
  const p = { ...DEFAULTS, ...params };
  const t = [
    { id:"baffle.soak", label:"Hood Baffle Soak", minutes:5 },
    { id:"microwave.steam", label:"Microwave Steam", minutes:4 },
  ];
  if (!p.kitchen.hasOvenSelfClean) t.push({ id:"oven.dwell", label:"Oven Cleaner Dwell", minutes:20 });
  t.push({ id:"laundry.reminder", label:"Start Cloths Laundry", minutes:5 });
  return t;
}

/* ---------------------------- Schedule Hints -------------------------------- */
function scheduleHintsFor(params){
  const p = { ...DEFAULTS, ...params };
  const hints = [
    { kind:"appliance", name:"vacuum", window:"20m", exclusive:false },
    { kind:"biohazard", rule:"chemicals-gloves-required" },
  ];
  if (p.preferences.quietHours?.startISO && p.preferences.quietHours?.endISO) {
    hints.push({ kind:"withholdAbsolute", start: toISO(p.preferences.quietHours.startISO), end: toISO(p.preferences.quietHours.endISO), reason:"quiet-hours" });
  }
  if (p.preferences.sabbathGuard && p.preferences.sabbathRange?.startISO && p.preferences.sabbathRange?.endISO){
    hints.push({ kind:"withholdAbsolute", start: toISO(p.preferences.sabbathRange.startISO), end: toISO(p.preferences.sabbathRange.endISO), reason:"sabbath-no-work" });
  }
  return hints;
}

/* --------------------------------- Factory ---------------------------------- */
export function createDeepCleanKitchenPlan(params = {}){
  const p = { ...DEFAULTS, ...params };
  const planId = id(["cleanplan", TEMPLATE_ID, p.kitchen.size, p.kitchen.greaseLevel]);

  const plan = {
    id: planId,
    templateId: TEMPLATE_ID,
    "x-domain": DOMAIN,
    "x-version": VERSION,
    title: "Deep Clean — Kitchen",
    description: "High→low method with oven, cabinets, counters, and floors. Eco-friendly options and material-safe guidance.",
    tags: ["cleaning","kitchen","deep-clean","eco","quiet"],

    params: p,
    resources: {
      equipment: [
        "Microfiber cloths", "Non-scratch pads",
        "Buckets (wash + rinse)", "Vacuum/Broom", "Mop",
        p.kitchen.hasRangeHood && "Range Hood Filters",
        p.kitchen.hasDishwasher && "Dishwasher Cleaner",
      ].filter(Boolean),
    },

    inventory: buildInventory(p),
    steps: stepsFor(p),
    timers: timersFor(p),
    scheduleHints: scheduleHintsFor(p),
    safety: { ppe:["gloves-nitrile"], ventilation:true },

    meta: {
      savable: true,
      favoriteable: true,
      authoring: { canFork: true, forkLabel: "Save your kitchen deep clean plan" },
      share: { portable: true },
    },

    toGroceryList(){
      return this.inventory.map(it => ({
        id: it.id, name: it.name, qty: it.qty, unit: it.unit, aisle: it.aisle, tags: it.tags
      }));
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

  // Let orchestration react (grocery list draft, reminders, etc.)
  try {
    const bus = (typeof window !== "undefined" && window.__suka_eventBus__) || null;
    bus?.emit?.("workplan.created", { domain: DOMAIN, templateId: TEMPLATE_ID, id: plan.id, params: p });
  } catch {}

  return plan;
}

/* -------------------------- Template Override Hook -------------------------- */
/** Prefer external library if present (allows household-specific variants). */
export async function getDeepCleanKitchenPlan(params = {}){
  try {
    const T = await import(/* @vite-ignore */ "@/libraries/CleanPlanTemplates");
    const api = T?.default ?? T;
    if (api?.get) {
      const external = await api.get(TEMPLATE_ID, params);
      if (external) return external;
    }
  } catch { /* optional */ }
  return createDeepCleanKitchenPlan(params);
}

/* --------------------------------- Export ----------------------------------- */
export default {
  id: TEMPLATE_ID,
  domain: DOMAIN,
  version: VERSION,
  defaults: DEFAULTS,
  create: createDeepCleanKitchenPlan,
  get: getDeepCleanKitchenPlan,
};
