// src/plans/animals/dailyFeeding.plan.js
/* eslint-disable no-console */
/**
 * dailyFeeding.plan.js — Adaptive daily animal feeding & observation routine
 *
 * Design goals
 * - Dynamic to species, herd size, weather, season, and available feed inventory
 * - Tied into InventoryMonitor + GardenHarvest data for smart substitutions
 * - Sabbath/quiet hours guard, eco & waste reduction mode
 * - Users can FAVORITE or fork (toPortable + toFavoriteSeed + withParams)
 * - Works with SessionHUD + MultiTimer for step visibility & time tracking
 *
 * Contract:
 * { id, templateId, x-domain, x-version, title, params, inventory,
 *   preflightChecks, steps, timers, scheduleHints, safety, meta, toPortable(),
 *   toGroceryList(), toFavoriteSeed(), withParams() }
 */

const VERSION = "1.2.0";
const DOMAIN = "animals";
const TEMPLATE_ID = "daily-feeding";

/* -------------------------------- Defaults --------------------------------- */
const DEFAULTS = {
  farm: { name: "Homestead", hasWellWater: true },
  date: new Date().toISOString(),

  species: [
    { kind: "sheep", count: 8, feedingType: "mixed" }, // hay + grain
    { kind: "goats", count: 4, feedingType: "browse" },
    { kind: "chickens", count: 12, feedingType: "scratch" },
  ],

  preferences: {
    ecoMode: true,
    fragranceFree: true,
    sabbathGuard: false,
    quietHours: null,  // { startISO, endISO }
    weatherAware: true,
  },

  // Weather/season context helps adapt hydration + shelter steps
  environment: {
    season: "spring",  // spring | summer | fall | winter
    weather: "mild",   // mild | hot | cold | rainy
  },

  mode: "standard", // express | standard | thorough

  schedule: {
    preflight: "-0m",
    feedPrep: "+2m",
    feedAnimals: "+6m",
    observe: "+20m",
    cleanup: "+26m",
    record: "+30m",
  },
};

/* --------------------------------- Helpers ---------------------------------- */
const id = (parts) => parts.filter(Boolean).join(":");
const clamp = (n,a,b)=>Math.max(a,Math.min(b,n));
const toISO = (d)=>{ try { return new Date(d).toISOString(); } catch { return null; } };

const modeMultiplier = (mode) => mode === "express" ? 0.8 : mode === "thorough" ? 1.3 : 1.0;
const seasonMultiplier = (season) =>
  season === "winter" ? 1.2 : season === "summer" ? 1.1 : 1.0;

/* ------------------------------ Inventory Build ----------------------------- */
function buildInventory(params){
  const p = { ...DEFAULTS, ...params };
  const inv = [];

  const multiplier = modeMultiplier(p.mode) * seasonMultiplier(p.environment.season);

  const feedPerAnimal = (kind) => {
    switch(kind){
      case "sheep": return 2.5; // lbs/head
      case "goats": return 2.0;
      case "chickens": return 0.25;
      default: return 1.0;
    }
  };

  p.species.forEach(sp => {
    inv.push({
      id: `${sp.kind}-feed`,
      name: `${sp.kind.charAt(0).toUpperCase() + sp.kind.slice(1)} Feed`,
      qty: Math.ceil(sp.count * feedPerAnimal(sp.kind) * multiplier),
      unit: "lbs",
      aisle: "Feed",
      tags: ["feed", sp.kind]
    });
    inv.push({
      id: `${sp.kind}-water`,
      name: `${sp.kind.charAt(0).toUpperCase() + sp.kind.slice(1)} Water`,
      qty: Math.ceil(sp.count * 1.5 * seasonMultiplier(p.environment.season)),
      unit: "gallons",
      aisle: "Water",
      tags: ["water", sp.kind]
    });
  });

  // Minerals, supplements (scaled)
  inv.push({ id:"minerals", name:"Mineral Mix", qty: Math.ceil(p.species.length * 0.5 * multiplier), unit:"lbs", aisle:"Feed", tags:["supplement"] });
  inv.push({ id:"salt-block", name:"Salt Block", qty:1, unit:"block", aisle:"Feed", tags:["supplement","salt"] });

  // Optional: bedding replenishment (winter or rainy)
  if (p.environment.season === "winter" || p.environment.weather === "rainy") {
    inv.push({ id:"bedding", name:"Dry Bedding / Straw", qty: p.species.length, unit:"bale", aisle:"Barn", tags:["comfort"] });
  }

  return inv;
}

/* ------------------------------- Preflight ---------------------------------- */
function buildPreflightChecks(params){
  const p = { ...DEFAULTS, ...params };
  const checks = [
    { id:"minerals", label:"Mineral mix available", kind:"inventory", minQty: 1, unit:"lbs" },
    { id:"salt-block", label:"Salt block in place", kind:"inventory", minQty: 1, unit:"block" },
  ];

  if (p.farm.hasWellWater){
    checks.push({ id:"well-pump", label:"Well pump functioning", kind:"status", mustBe:true });
  }

  p.species.forEach(sp=>{
    checks.push({ id:`${sp.kind}-feed`, label:`${sp.kind} feed available`, kind:"inventory", minQty: Math.ceil(sp.count * 0.5), unit:"lbs" });
  });

  return checks;
}

/* --------------------------------- Steps ------------------------------------ */
function stepsFor(params){
  const p = { ...DEFAULTS, ...params };
  const s = p.schedule;
  const steps = [];

  steps.push({
    id:"preflight",
    title:"Preflight Check",
    offset: s.preflight,
    duration:"2m",
    kind:"prep",
    instructions:[
      "Confirm feed bins stocked & water supply functioning.",
      "Check weather: adjust shelter plans if stormy or cold."
    ],
    signals:[{ type:"ui/progress", value:0.05 }]
  });

  steps.push({
    id:"feed-prep",
    title:"Prepare Feed & Supplements",
    offset: s.feedPrep,
    duration: Math.round(5 * modeMultiplier(p.mode)) + "m",
    kind:"prep",
    instructions:[
      "Measure feed by species and portion into labeled buckets.",
      "Add minerals or supplements as appropriate.",
      p.preferences.ecoMode ? "Use reusable buckets; avoid single-use plastics." : null
    ].filter(Boolean),
    signals:[{ type:"ui/progress", value:0.2 }]
  });

  steps.push({
    id:"feed-animals",
    title:"Feed & Water Animals",
    offset: s.feedAnimals,
    duration: Math.round(12 * modeMultiplier(p.mode)) + "m",
    kind:"routine",
    instructions:[
      "Deliver feed starting with younger or weaker animals first.",
      "Ensure all troughs and waterers are clean and filled.",
      "Observe appetite and demeanor for each group."
    ],
    reminders:[
      { kind:"timer", label:"Water Check", minutes:15 },
      { kind:"timer", label:"Feed Review", minutes:10 }
    ],
    signals:[{ type:"ui/progress", value:0.5 }]
  });

  steps.push({
    id:"observe",
    title:"Health & Behavior Observation",
    offset: s.observe,
    duration: Math.round(10 * modeMultiplier(p.mode)) + "m",
    kind:"observation",
    instructions:[
      "Check eyes, coat, and movement; note limping or lethargy.",
      "Ensure no aggression around feed areas.",
      "Record abnormal findings in Health Log."
    ],
    signals:[{ type:"ui/progress", value:0.7 }]
  });

  steps.push({
    id:"cleanup",
    title:"Clean Feeding Areas",
    offset: s.cleanup,
    duration:"6m",
    kind:"cleanup",
    instructions:[
      "Collect leftover feed to prevent spoilage.",
      "Rinse buckets and troughs with clean water.",
      p.preferences.ecoMode ? "Use minimal water; collect rinse water for garden use." : null
    ].filter(Boolean),
    signals:[{ type:"ui/progress", value:0.9 }]
  });

  steps.push({
    id:"record",
    title:"Record Feed & Notes",
    offset: s.record,
    duration:"3m",
    kind:"record",
    instructions:[
      "Log feed amounts, observations, and weather in Animal Log.",
      "Update inventory quantities.",
    ],
    signals:[{ type:"ui/progress", value:1 }]
  });

  return steps;
}

/* -------------------------------- Timers ------------------------------------ */
function timersFor(params){
  const p = { ...DEFAULTS, ...params };
  return [
    { id:"feed.check", label:"Feed Review", minutes:10 },
    { id:"water.check", label:"Water Check", minutes:15 },
  ];
}

/* ---------------------------- Schedule Hints -------------------------------- */
function scheduleHintsFor(params){
  const p = { ...DEFAULTS, ...params };
  const hints = [];

  if (p.preferences.quietHours?.startISO && p.preferences.quietHours?.endISO) {
    hints.push({
      kind:"withholdAbsolute",
      start: toISO(p.preferences.quietHours.startISO),
      end: toISO(p.preferences.quietHours.endISO),
      reason:"quiet-hours"
    });
  }
  if (p.preferences.sabbathGuard && p.preferences.sabbathRange?.startISO && p.preferences.sabbathRange?.endISO){
    hints.push({
      kind:"withholdAbsolute",
      start: toISO(p.preferences.sabbathRange.startISO),
      end: toISO(p.preferences.sabbathRange.endISO),
      reason:"sabbath-no-work"
    });
  }

  if (p.preferences.weatherAware){
    hints.push({ kind:"weather", importance:"medium" });
  }

  return hints;
}

/* --------------------------------- Factory ---------------------------------- */
export function createDailyFeedingPlan(params = {}){
  const p = { ...DEFAULTS, ...params };
  const planId = id(["animalplan", TEMPLATE_ID, p.mode, p.environment.season]);

  const plan = {
    id: planId,
    templateId: TEMPLATE_ID,
    "x-domain": DOMAIN,
    "x-version": VERSION,
    title: "Daily Feeding & Observation Plan",
    description: "Adaptive feeding, watering, and health observation routine for mixed species herds with preflight checks and eco adjustments.",
    tags: ["animals","feeding","routine","eco",p.mode,p.environment.season],

    params: p,
    inventory: buildInventory(p),
    preflightChecks: buildPreflightChecks(p),
    steps: stepsFor(p),
    timers: timersFor(p),
    scheduleHints: scheduleHintsFor(p),
    safety: { ppe:[], ventilation:false },

    meta: {
      savable: true,
      favoriteable: true,
      authoring: { canFork: true, forkLabel: "Save your daily feeding routine" },
      share: { portable: true },
      ui: { chips: [p.mode, p.environment.season, p.preferences.ecoMode ? "eco":"std"].filter(Boolean) }
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
        preflightChecks: this.preflightChecks,
        steps: this.steps,
        timers: this.timers,
        tags: this.tags,
      };
    },

    toFavoriteSeed(userTitle = this.title){
      return {
        kind: "favorite:workplan",
        title: userTitle,
        domain: this["x-domain"],
        templateId: this.templateId,
        params: this.params,
        version: this["x-version"],
        tags: this.tags,
      };
    },

    withParams(patch = {}){
      return createDailyFeedingPlan({ ...this.params, ...patch });
    }
  };

  // Emit to eventBus for orchestration (inventory sync, reminders, etc.)
  try {
    const bus = (typeof window !== "undefined" && window.__suka_eventBus__) || null;
    bus?.emit?.("workplan.created", { domain: DOMAIN, templateId: TEMPLATE_ID, id: plan.id, params: p });
  } catch {}

  return plan;
}

/* -------------------------- Template Override Hook -------------------------- */
export async function getDailyFeedingPlan(params = {}){
  try {
    const T = await import(/* @vite-ignore */ "@/libraries/AnimalPlanTemplates");
    const api = T?.default ?? T;
    if (api?.get) {
      const external = await api.get(TEMPLATE_ID, params);
      if (external) return external;
    }
  } catch { /* optional */ }
  return createDailyFeedingPlan(params);
}

/* --------------------------------- Export ----------------------------------- */
export default {
  id: TEMPLATE_ID,
  domain: DOMAIN,
  version: VERSION,
  defaults: DEFAULTS,
  create: createDailyFeedingPlan,
  get: getDailyFeedingPlan,
};
