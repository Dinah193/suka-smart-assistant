// src/plans/animals/butcheryBasic.plan.js
/* eslint-disable no-console */
/**
 * butcheryBasic.plan.js — Adaptive on-farm butchery (all species) + processor drop-off
 *
 * Design goals
 * - One plan covers: on-farm poultry, on-farm red meat (lamb/goat/beef), and processor drop-off
 * - Scales durations & consumables by species, count, ambient temp/season, and mode
 * - Food-safety first: sanitizer dwell, cold chain targets, carcass chill/aging
 * - Preflight checks (InventoryMonitor hooks) incl. legal/permit acknowledgement
 * - Sabbath/quiet-hours guards; namespaced UI signals; portable & favorites
 *
 * Contract
 * { id, templateId, x-domain, x-version, title, params, inventory, preflightChecks, steps, timers,
 *   scheduleHints, safety, meta, actions, toPortable(), toGroceryList(), toFavoriteSeed(), withParams() }
 */

const VERSION = "1.3.0";
const DOMAIN = "animals";
const TEMPLATE_ID = "butchery-basic";

/* -------------------------------- Defaults --------------------------------- */
const DEFAULTS = {
  // Workflow: on-farm for any supported species, or processor drop-off for red meat
  workflow: "on-farm",              // "on-farm" | "processor-dropoff"

  // Species & batch
  species: "chicken",               // "chicken" | "turkey" | "lamb" | "goat" | "beef"
  count: 8,

  // Session pacing
  mode: "standard",                 // "express" | "standard" | "thorough"

  // Packaging & labeling
  packaging: {
    method: "vacuum",               // "vacuum" | "butcher-paper"
    labelFormat: "YYYY-MM-DD cut weight", // UI hint only
  },

  // Environment
  environment: {
    ambientC: 18,                   // °C (affects ice/chill)
    season: "spring",               // "spring" | "summer" | "fall" | "winter"
    hasWalkIn: false,               // walk-in cooler available
  },

  // Preferences & guards
  preferences: {
    ecoMode: true,
    fragranceFree: true,
    sabbathGuard: false,
    quietHours: null,               // { startISO, endISO }
    sabbathRange: null,             // { startISO, endISO }
    legalChecklistAck: false,       // user confirms local regs/permits arranged
  },

  // Food-safety (display & timers)
  foodSafety: {
    sanitizeDwellMin: 2,            // sanitizer contact time (minutes)
    poultryChillTargetC: 4,         // ≤ 4°C within 4h
    redChillTargetC: 7,             // carcass ≤ 7°C within 24h (common guidance)
    redHangDays: 0,                 // on-farm optional aging, if cooler available
  },

  // Processor metadata (drop-off flow)
  processor: {
    name: "",
    address: "",
    dropoffWindowISO: null,         // e.g., "2025-11-03T08:00:00-05:00"
    pickupETAISO: null,
  },

  // Relative schedule; durations scale, offsets keep rhythm
  schedule: {
    preflight: "-0m",

    // on-farm shared/poultry
    staging: "+5m",
    dispatch: "+20m",
    scaldPluck: "+32m",
    eviscerate: "+50m",
    poultryChill: "+70m",

    // on-farm red meat
    restrainStun: "+20m",
    bleed: "+26m",
    skin: "+40m",
    eviscerateRed: "+70m",
    splitQuarter: "+100m",
    redChill: "+130m",
    redAge: "+999m", // placeholder; calendar can pin days
    breakdown: "+160m",

    // shared finish
    pack: "+190m",
    cleanup: "+210m",
    record: "+220m",

    // processor path
    paperwork: "+10m",
    load: "+20m",
    drive: "+40m",
    dropoff: "+80m",
    pickup: "+999m",
  },
};

/* --------------------------------- Helpers ---------------------------------- */
const id = (parts) => parts.filter(Boolean).join(":");
const clamp = (n,a,b)=>Math.max(a,Math.min(b,n));
const toISO = (d)=>{ try { return new Date(d).toISOString(); } catch { return null; } };

const modeMultiplier = (mode) => mode === "express" ? 0.85 : mode === "thorough" ? 1.25 : 1.0;
const speciesScale = (sp) => {
  switch(sp){
    case "turkey": return 1.6;
    case "lamb": case "goat": return 2.4;
    case "beef": return 6.0;
    default: return 1.0; // chicken baseline
  }
};
const isPoultry = (sp) => sp === "chicken" || sp === "turkey";
const isRedMeat = (sp) => sp === "lamb" || sp === "goat" || sp === "beef";

/* ------------------------------ Inventory Build ----------------------------- */
/**
 * Consumables/tools sized for session; InventoryMonitor can surface short/low.
 * Ice (poultry) & chill capacity (red meat) adjust for ambient temp/season.
 */
function buildInventory(params){
  const p = { ...DEFAULTS, ...params };
  const inv = [];
  const mm = modeMultiplier(p.mode);
  const ss = speciesScale(p.species);

  const hot = p.environment.ambientC >= 25;
  const warm = p.environment.ambientC >= 15 && p.environment.ambientC < 25;

  // Ice & chill plan
  if (p.workflow === "on-farm" && isPoultry(p.species)) {
    const ambientFactor = hot ? 2.2 : warm ? 1.7 : 1.3;
    const kgIce = Math.ceil(p.count * 1.8 * ambientFactor * mm);
    inv.push({ id:"ice", name:"Ice", qty: kgIce, unit:"kg", aisle:"Freezer", tags:["cold-chain","poultry"] });
  }
  if (p.workflow === "on-farm" && isRedMeat(p.species)) {
    inv.push({ id:"cooling-capacity", name: p.environment.hasWalkIn ? "Walk-in Cooler (reserved)" : "Iced Chiller/Totes (reserved)", qty: 1, unit:"unit", aisle:"Equipment", tags:["cold-chain","red-meat"] });
    inv.push({ id:"temp-logger", name:"Carcass Temp Logger / Probe", qty: 1, unit:"ea", aisle:"Kitchen", tags:["temp"] });
  }

  // Packaging
  if (params?.packaging?.method === "butcher-paper") {
    inv.push({ id:"butcher-paper", name:"Butcher Paper Roll", qty: Math.ceil(1 * ss), unit:"roll", aisle:"Kitchen", tags:["packaging"] });
    inv.push({ id:"freezer-tape", name:"Freezer Tape", qty: 1, unit:"roll", aisle:"Kitchen", tags:["packaging"] });
  } else {
    inv.push({ id:"vacuum-rolls", name:"Vacuum Sealer Rolls", qty: Math.ceil(p.count * (isRedMeat(p.species) ? 3 : 2) * ss), unit:"rolls", aisle:"Kitchen", tags:["packaging"] });
  }
  inv.push({ id:"labels", name:"Freezer Labels + Marker", qty: 1, unit:"set", aisle:"Office", tags:["label"] });

  // Sanitizer & PPE
  inv.push({ id:"sanitizer", name: p.preferences.ecoMode ? "Food-Contact Sanitizer (Fragrance-Free)" : "Food-Contact Sanitizer", qty: 1000, unit:"ml", aisle:"Cleaning", tags:["sanitize", p.preferences.fragranceFree?"fragrance-free":""].filter(Boolean) });
  inv.push({ id:"gloves-nitrile", name:"Nitrile Gloves", qty: 1, unit:"box", aisle:"Health", tags:["ppe"] });
  inv.push({ id:"apron", name:"Apron (Waterproof)", qty: 1, unit:"ea", aisle:"Safety", tags:["ppe"] });

  // Tools
  inv.push({ id:"thermometer", name:"Probe Thermometer", qty: 1, unit:"ea", aisle:"Kitchen", tags:["temp"] });
  inv.push({ id:"knives", name:"Sharp Knives + Steel", qty: 1, unit:"set", aisle:"Equipment", tags:["tool"] });
  inv.push({ id:"tubs", name:"Food Tubs / Trays", qty: Math.ceil((isRedMeat(p.species) ? 6 : 3) * ss), unit:"ea", aisle:"Equipment", tags:["staging"] });

  // Species-specific tools
  if (p.workflow === "on-farm" && isPoultry(p.species)) {
    inv.push({ id:"scalder", name:"Scalder / Pot (large)", qty: 1, unit:"ea", aisle:"Equipment", tags:["tool"] });
    inv.push({ id:"plucker", name:"Plucker (optional)", qty: 1, unit:"ea", aisle:"Equipment", tags:["tool"] });
  }
  if (p.workflow === "on-farm" && isRedMeat(p.species)) {
    inv.push({ id:"gambrel", name:"Gambrel/Hook Set", qty: 1, unit:"set", aisle:"Equipment", tags:["tool"] });
    inv.push({ id:"hoist", name:"Hoist / Winch (safe working limit)", qty: 1, unit:"ea", aisle:"Equipment", tags:["tool"] });
    inv.push({ id:"bone-saw", name:"Butcher/Reciprocating Saw", qty: 1, unit:"ea", aisle:"Equipment", tags:["tool"] });
    inv.push({ id:"game-bags", name:"Game Bags / Cheesecloth", qty: Math.max(2, Math.ceil(p.count * ss)), unit:"ea", aisle:"Equipment", tags:["tool","clean"] });
    inv.push({ id:"hide-scraper", name:"Hide Puller/Scraper (optional)", qty: 1, unit:"ea", aisle:"Equipment", tags:["tool"] });
  }

  return inv;
}

/* ------------------------------- Preflight ---------------------------------- */
function buildPreflightChecks(params){
  const p = { ...DEFAULTS, ...params };
  const checks = [
    { id:"gloves-nitrile", label:"Gloves available", kind:"inventory", minQty: 1, unit:"box" },
    { id:"sanitizer", label:"Sanitizer available", kind:"inventory", minQty: 250, unit:"ml" },
    { id:"thermometer", label:"Probe thermometer present", kind:"inventory", minQty: 1, unit:"ea" },
    { id:"knives", label:"Knives sharpened", kind:"status", mustBe:true },
    { id:"labels", label:"Labels & marker ready", kind:"inventory", minQty: 1, unit:"set" },
    { id:"legal", label:"Local regulations/permits arranged", kind:"status", mustBe: !!p.preferences.legalChecklistAck },
  ];

  if (p.workflow === "on-farm" && isPoultry(p.species)) {
    checks.push({ id:"ice", label:"Ice on hand", kind:"inventory", minQty: Math.ceil(p.count * 2), unit:"kg" });
    checks.push({ id:"scalder", label:"Scalder/pot available", kind:"inventory", minQty: 1, unit:"ea" });
  }
  if (p.workflow === "on-farm" && isRedMeat(p.species)) {
    checks.push({ id:"gambrel", label:"Gambrel/hooks", kind:"inventory", minQty: 1, unit:"set" });
    checks.push({ id:"hoist", label:"Hoist capacity OK", kind:"status", mustBe:true });
    checks.push({ id:"bone-saw", label:"Butcher saw present", kind:"inventory", minQty: 1, unit:"ea" });
    checks.push({ id:"cooling-capacity", label:"Chilling capacity reserved", kind:"inventory", minQty: 1, unit:"unit" });
  }
  if (p.workflow === "processor-dropoff") {
    checks.push({ id:"paperwork", label:"Cut sheet/paperwork prepared", kind:"status", mustBe:true });
  }

  return checks;
}

/* --------------------------------- Steps ------------------------------------ */
function poultryOnFarmSteps(p, s){
  const mm = modeMultiplier(p.mode);
  const dwell = clamp(Number(p.foodSafety?.sanitizeDwellMin) || 2, 1, 10);
  const chillTarget = clamp(Number(p.foodSafety?.poultryChillTargetC) || 4, 0, 10);

  return [
    {
      id:"preflight",
      title:"Preflight & PPE",
      offset: s.preflight,
      duration: Math.round(5 * mm) + "m",
      kind:"setup",
      instructions:[
        "Ventilate work area; set up clean/dirty zones.",
        "Put on gloves and apron.",
        "Mix sanitizer per label; set timer for dwell between batches."
      ],
      reminders:[{ kind:"timer", label:"Sanitizer Dwell", minutes: dwell }],
      signals:[{ type:"ui/progress", value:0.05 }]
    },
    {
      id:"staging",
      title:"Stage Equipment & Ice Baths",
      offset: s.staging,
      duration: Math.round(10 * mm) + "m",
      kind:"staging",
      instructions:[
        "Set up cones/dispatch area (humane handling).",
        "Prepare ice baths; target slurry ≤ 4°C.",
        "Lay out tubs: pluck, eviscerate, rinse, chill."
      ],
      signals:[{ type:"ui/progress", value:0.15 }]
    },
    {
      id:"dispatch",
      title:"Dispatch & Bleed (Humane Handling)",
      offset: s.dispatch,
      duration: Math.round(Math.max(10, p.count * 1.2) * mm) + "m",
      kind:"harvest",
      instructions:[
        "Handle birds calmly; minimize stress.",
        "Dispatch and bleed thoroughly in cone."
      ],
      safety:{ ppe:["gloves-nitrile","eye-protection"] },
      signals:[{ type:"ui/progress", value:0.3 }]
    },
    {
      id:"scaldPluck",
      title:"Scald / Pluck",
      offset: s.scaldPluck,
      duration: Math.round(Math.max(12, p.count * 1.6) * mm) + "m",
      kind:"process",
      instructions:[
        "Scald at ~62–65°C until feathers release.",
        "Pluck (machine or by hand)."
      ]
    },
    {
      id:"eviscerate",
      title:"Eviscerate & Rinse",
      offset: s.eviscerate,
      duration: Math.round(Math.max(20, p.count * 2.2) * mm) + "m",
      kind:"process",
      instructions:[
        "Eviscerate carefully; avoid contamination; rinse in potable water.",
        `Sanitize tables/tools (dwell ${dwell}m) between batches.`
      ],
      reminders:[{ kind:"timer", label:"Sanitizer Dwell", minutes: dwell }],
      safety:{ ppe:["gloves-nitrile"] },
      signals:[{ type:"ui/progress", value:0.55 }]
    },
    {
      id:"poultryChill",
      title:`Chill to ≤ ${chillTarget}°C within 4 hours`,
      offset: s.poultryChill,
      duration: Math.round(Math.max(40, p.count * 4) * mm) + "m",
      kind:"cold-chain",
      instructions:[
        "Immerse carcasses in ice bath; agitate occasionally.",
        "Rotate fresh ice as needed; verify temp with probe."
      ],
      reminders:[{ kind:"timer", label:"Cold Chain Check", minutes: 30 }],
      signals:[{ type:"ui/progress", value:0.7 }]
    },
    {
      id:"breakdown",
      title:"Breakdown (optional) & Trim",
      offset: s.breakdown,
      duration: Math.round(Math.max(20, p.count * 2) * mm) + "m",
      kind:"butcher",
      instructions:[
        "Whole-bird or part into cuts (breast, leg quarters, wings, bones for stock).",
        "Keep product cold; return to ice between batches."
      ],
      signals:[{ type:"ui/progress", value:0.85 }]
    },
    {
      id:"pack",
      title:"Pack, Label, and Freeze/Fridge",
      offset: s.pack,
      duration: Math.round(Math.max(15, p.count * 1.2) * mm) + "m",
      kind:"pack",
      instructions:[
        p.packaging.method === "butcher-paper" ? "Wrap tightly; tape seams." : "Vac-seal; avoid liquid in seal zone.",
        `Label: ${p.packaging.labelFormat || "date cut weight"}.`,
        "Freeze promptly or refrigerate ≤ 4°C."
      ],
    },
    ...sharedFinishSteps(p, s, mm)
  ];
}

function redOnFarmSteps(p, s){
  const mm = modeMultiplier(p.mode);
  const dwell = clamp(Number(p.foodSafety?.sanitizeDwellMin) || 2, 1, 10);
  const chillTarget = clamp(Number(p.foodSafety?.redChillTargetC) || 7, 0, 10);
  const hangDays = Math.max(0, Number(p.foodSafety?.redHangDays) || 0);

  return [
    {
      id:"preflight",
      title:"Preflight & PPE",
      offset: s.preflight,
      duration: Math.round(6 * mm) + "m",
      kind:"setup",
      instructions:[
        "Reserve cooler/chiller; verify temp setpoint.",
        "Put on gloves and apron; set up clean/dirty zones.",
        "Mix sanitizer per label; set timer for dwell."
      ],
      reminders:[{ kind:"timer", label:"Sanitizer Dwell", minutes: dwell }],
      signals:[{ type:"ui/progress", value:0.05 }]
    },
    {
      id:"restrainStun",
      title:"Restrain & Humane Stun",
      offset: s.restrainStun,
      duration: Math.round(10 * mm) + "m",
      kind:"harvest",
      instructions:[
        "Humanely restrain/stun per species and local regulation.",
        "Prepare for immediate bleed."
      ],
      safety:{ ppe:["gloves-nitrile","eye-protection"] },
      signals:[{ type:"ui/progress", value:0.16 }]
    },
    {
      id:"bleed",
      title:"Bleed & Hang",
      offset: s.bleed,
      duration: Math.round(10 * mm) + "m",
      kind:"harvest",
      instructions:[
        "Sever appropriate vessels; allow full bleed.",
        "Hang on gambrel/hooks securely."
      ],
      signals:[{ type:"ui/progress", value:0.26 }]
    },
    {
      id:"skin",
      title:"Skin/Hide Removal",
      offset: s.skin,
      duration: Math.round(30 * mm * speciesScale(p.species)) + "m",
      kind:"process",
      instructions:[
        "Skin carefully to avoid contamination; bag/contain hide.",
        `Sanitize tables/tools between phases (dwell ${dwell}m).`
      ],
      reminders:[{ kind:"timer", label:"Sanitizer Dwell", minutes: dwell }],
      signals:[{ type:"ui/progress", value:0.42 }]
    },
    {
      id:"eviscerateRed",
      title:"Eviscerate & Rinse",
      offset: s.eviscerateRed,
      duration: Math.round(30 * mm * speciesScale(p.species)) + "m",
      kind:"process",
      instructions:[
        "Eviscerate; avoid gut rupture. Remove pluck; rinse cavity with potable water.",
        "Trim contamination if present; re-sanitize area."
      ],
      signals:[{ type:"ui/progress", value:0.58 }]
    },
    {
      id:"splitQuarter",
      title:"Split / Quarter",
      offset: s.splitQuarter,
      duration: Math.round(25 * mm * speciesScale(p.species)) + "m",
      kind:"butcher",
      instructions:[
        "Split beef carcass/quarter small ruminants as needed.",
        "Bag/cover with clean game bags/cheesecloth."
      ],
      signals:[{ type:"ui/progress", value:0.7 }]
    },
    {
      id:"redChill",
      title:`Chill Carcass to ≤ ${chillTarget}°C within 24h`,
      offset: s.redChill,
      duration: Math.round(60 * mm) + "m",
      kind:"cold-chain",
      instructions:[
        p.environment.hasWalkIn ? "Move to walk-in cooler; ensure airflow." : "Stage in chiller/iced totes; monitor temps.",
        "Insert temp probe/logger; record hourly trend initially."
      ],
      reminders:[{ kind:"timer", label:"Cold Chain Check", minutes: 60 }],
      signals:[{ type:"ui/progress", value:0.8 }]
    },
    ...(hangDays > 0 ? [{
      id:"redAge",
      title:`Optional Aging — ${hangDays} day(s)`,
      offset: s.redAge,
      duration: `${hangDays}d`,
      kind:"aging",
      instructions:[
        `Hold at 0–2°C with airflow for ${hangDays} day(s).`,
        "Check surface dryness; trim as needed before breakdown."
      ],
      schedule:[{ kind:"appointment", startsAt: toISO(new Date()) }], // placeholder; app will pin dates
      signals:[{ type:"ui/progress", value:0.86 }]
    }] : []),
    {
      id:"breakdown",
      title:"Breakdown to Primals/Cuts",
      offset: s.breakdown,
      duration: Math.round(60 * mm * speciesScale(p.species)) + "m",
      kind:"butcher",
      instructions:[
        "Break to primals; then retail cuts per preference.",
        "Keep chain cold; return pieces to cooler between batches."
      ],
      signals:[{ type:"ui/progress", value:0.92 }]
    },
    {
      id:"pack",
      title:"Pack, Label, and Freeze/Fridge",
      offset: s.pack,
      duration: Math.round(30 * mm * speciesScale(p.species)) + "m",
      kind:"pack",
      instructions:[
        p.packaging.method === "butcher-paper" ? "Wrap tightly; tape seams." : "Vac-seal; avoid moisture in seal zone.",
        `Label: ${p.packaging.labelFormat || "date cut weight"}.`,
        "Freeze promptly or refrigerate ≤ 4°C."
      ],
    },
    ...sharedFinishSteps(p, s, mm)
  ];
}

function processorDropoffSteps(p, s){
  const mm = modeMultiplier(p.mode);
  return [
    {
      id:"preflight",
      title:"Preflight & Paperwork",
      offset: s.preflight,
      duration: Math.round(6 * mm) + "m",
      kind:"admin",
      instructions:[
        "Confirm processor requirements, fees, deposit.",
        "Complete cut sheet (steaks/roasts/ground ratios)."
      ],
      signals:[{ type:"ui/progress", value:0.08 }]
    },
    {
      id:"paperwork",
      title:"Cut Sheet & Labels",
      offset: s.paperwork,
      duration: Math.round(10 * mm) + "m",
      kind:"admin",
      instructions:[
        "Print/prepare labels; verify contact info.",
        p.foodSafety.redHangDays ? `Request aging: ${p.foodSafety.redHangDays} day(s).` : null
      ].filter(Boolean)
    },
    {
      id:"load",
      title:"Load & Secure for Transport",
      offset: s.load,
      duration: Math.round(15 * mm) + "m",
      kind:"staging",
      instructions:[
        "Load animals safely per welfare guidelines.",
        "Bring cut sheet, deposit, labelled bins/coolers if needed."
      ],
      signals:[{ type:"ui/progress", value:0.2 }]
    },
    {
      id:"drive",
      title:"Drive to Processor",
      offset: s.drive,
      duration: Math.round(30 * mm) + "m",
      kind:"transport",
      instructions:[ p.processor.address ? `Destination: ${p.processor.address}` : "Drive to scheduled processor." ],
      schedule: p.processor.dropoffWindowISO ? [{ kind:"appointment", startsAt: toISO(p.processor.dropoffWindowISO) }] : []
    },
    {
      id:"dropoff",
      title:"Drop-off & Confirm Pickup ETA",
      offset: s.dropoff,
      duration: "10m",
      kind:"handoff",
      instructions:[
        "Confirm cut sheet and labels; ask about fees and aging.",
        p.processor.pickupETAISO ? `Pickup ETA: ${new Date(p.processor.pickupETAISO).toLocaleString()}` : "Confirm pickup window."
      ],
      signals:[{ type:"ui/progress", value:0.65 }]
    },
    {
      id:"pickup",
      title:"Pickup & Freezer Load (when notified)",
      offset: s.pickup,
      duration: "20m",
      kind:"return",
      instructions:[
        "Bring coolers. Verify labeling & counts on invoice.",
        "Load freezer; rotate older stock forward."
      ],
      schedule: p.processor.pickupETAISO ? [{ kind:"appointment", startsAt: toISO(p.processor.pickupETAISO) }] : [],
      signals:[{ type:"ui/progress", value:0.95 }]
    },
    ...sharedFinishSteps(p, s, mm, { skipCleanup: true }) // processor handles facility cleanup
  ];
}

function sharedFinishSteps(p, s, mm, opts = {}){
  const steps = [];
  if (!opts.skipCleanup) {
    steps.push({
      id:"cleanup",
      title:"Cleanup & Sanitize",
      offset: s.cleanup,
      duration: Math.round(12 * mm) + "m",
      kind:"cleanup",
      instructions:[
        `Sanitize tables/tools (dwell ${clamp(Number(p.foodSafety?.sanitizeDwellMin)||2,1,10)}m).`,
        "Bag waste per local rules; freeze high-odor scraps until trash day if needed."
      ],
    });
  }
  steps.push({
    id:"record",
    title:"Record Weights & Notes",
    offset: s.record,
    duration: "6m",
    kind:"record",
    instructions:[
      "Log yield weights by cut; note trim or contamination removed.",
      "Update freezer inventory and costs."
    ],
    signals:[{ type:"ui/progress", value:1 }]
  });
  return steps;
}

/* -------------------------------- Timers ------------------------------------ */
function timersFor(params){
  const p = { ...DEFAULTS, ...params };
  const t = [];
  const dwell = clamp(Number(p.foodSafety?.sanitizeDwellMin) || 2, 1, 10);
  if (p.workflow === "on-farm" && isPoultry(p.species)) {
    t.push({ id:"sanitizer.dwell", label:"Sanitizer Dwell", minutes: dwell });
    t.push({ id:"coldchain.check", label:"Cold Chain Check", minutes: 30 });
  }
  if (p.workflow === "on-farm" && isRedMeat(p.species)) {
    t.push({ id:"sanitizer.dwell", label:"Sanitizer Dwell", minutes: dwell });
    t.push({ id:"coldchain.check", label:"Cold Chain Check", minutes: 60 });
  }
  return t;
}

/* ---------------------------- Schedule Hints -------------------------------- */
function scheduleHintsFor(params){
  const p = { ...DEFAULTS, ...params };
  const hints = [
    { kind:"biohazard", rule:"animal-processing-ppe" },
    { kind:"ventilation", window:"session" },
    { kind:"appliance", name:"freezer", window:"end", exclusive:false }, // ensure space
  ];
  if (p.preferences.quietHours?.startISO && p.preferences.quietHours?.endISO) {
    hints.push({ kind:"withholdAbsolute", start: toISO(p.preferences.quietHours.startISO), end: toISO(p.preferences.quietHours.endISO), reason:"quiet-hours" });
  }
  if (p.preferences.sabbathGuard && p.preferences.sabbathRange?.startISO && p.preferences.sabbathRange?.endISO) {
    hints.push({ kind:"withholdAbsolute", start: toISO(p.preferences.sabbathRange.startISO), end: toISO(p.preferences.sabbathRange.endISO), reason:"sabbath-no-work" });
  }
  return hints;
}

/* --------------------------------- Factory ---------------------------------- */
export function createButcheryBasicPlan(params = {}){
  const p = { ...DEFAULTS, ...params };

  const path =
    p.workflow === "processor-dropoff" ? "processor" :
    isPoultry(p.species) ? "onfarm-poultry" :
    isRedMeat(p.species) ? "onfarm-red" : "onfarm-other";

  const planId = id(["animalplan", TEMPLATE_ID, path, p.species, `${p.count}ct`]);

  const title = (() => {
    if (p.workflow === "processor-dropoff") return `Butchery — Processor Drop-off (${p.species})`;
    if (isPoultry(p.species)) return `Butchery — On-Farm Poultry (x${p.count})`;
    if (isRedMeat(p.species)) return `Butchery — On-Farm ${p.species.charAt(0).toUpperCase()+p.species.slice(1)}`;
    return `Butchery — On-Farm (${p.species})`;
  })();

  const steps =
    p.workflow === "processor-dropoff"
      ? processorDropoffSteps(p, p.schedule)
      : isPoultry(p.species)
        ? poultryOnFarmSteps(p, p.schedule)
        : redOnFarmSteps(p, p.schedule);

  const plan = {
    id: planId,
    templateId: TEMPLATE_ID,
    "x-domain": DOMAIN,
    "x-version": VERSION,

    title,
    description:
      p.workflow === "processor-dropoff"
        ? "Red meat processor drop-off workflow with paperwork, transport, pickup, and freezer load."
        : isPoultry(p.species)
          ? "On-farm poultry harvest with food-safety prompts, cold-chain checkpoints, and scalable packaging."
          : "On-farm red-meat harvest (lamb/goat/beef) with humane handling, skin/eviscerate, chill/optional aging, breakdown, and packing.",

    tags: ["animals","butchery", p.workflow, p.species, params?.packaging?.method || DEFAULTS.packaging.method],

    params: p,
    inventory: buildInventory(p),
    preflightChecks: buildPreflightChecks(p),

    steps,
    timers: timersFor(p),
    scheduleHints: scheduleHintsFor(p),

    safety: { ppe:["gloves-nitrile","apron"], ventilation:true },

    meta: {
      savable: true,
      favoriteable: true,
      authoring: { canFork: true, forkLabel: "Save your butchery workflow" },
      share: { portable: true },
      ui: { chips: [p.workflow, p.species, p.packaging?.method || "vacuum"].filter(Boolean) }
    },

    actions: [
      { id:"start-timers", label:"Start Session Timers", kind:"session", payload:{ start:true } },
      { id:"open-checklist", label:"Open Checklist", kind:"ui", payload:{ section:"butchery" } },
    ],

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
      return createButcheryBasicPlan({ ...this.params, ...patch });
    }
  };

  // Orchestration hook: let the app react (inventory checks, reminders, cooler capacity)
  try {
    const bus = (typeof window !== "undefined" && window.__suka_eventBus__) || null;
    bus?.emit?.("workplan.created", { domain: DOMAIN, templateId: TEMPLATE_ID, id: plan.id, params: p });
  } catch {}

  return plan;
}

/* -------------------------- Template Override Hook -------------------------- */
export async function getButcheryBasicPlan(params = {}){
  try {
    const T = await import(/* @vite-ignore */ "@/libraries/AnimalPlanTemplates");
    const api = T?.default ?? T;
    if (api?.get) {
      const external = await api.get(TEMPLATE_ID, params);
      if (external) return external;
    }
  } catch { /* optional */ }
  return createButcheryBasicPlan(params);
}

/* --------------------------------- Export ----------------------------------- */
export default {
  id: TEMPLATE_ID,
  domain: DOMAIN,
  version: VERSION,
  defaults: DEFAULTS,
  create: createButcheryBasicPlan,
  get: getButcheryBasicPlan,
};
