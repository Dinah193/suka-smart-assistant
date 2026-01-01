// src/plans/garden/transplantBed.plan.js
/* eslint-disable no-console */
/**
 * transplantBed.plan.js — Adaptive transplanting workflow for a single bed
 *
 * Design goals
 * - Dynamic to bed size (L×W), plant spacing, crop family, season, and weather guardrails
 * - Quantity calculators for compost/amendments, seedlings, mulch, and row cover
 * - Preflight checks that pair with InventoryMonitor (offer “add to list” before starting)
 * - Quiet hours & Sabbath guard via schedule hints
 * - Users can FAVORITE or fork (toPortable + toFavoriteSeed + withParams)
 * - Namespaced signals for SessionHUD; timers for dwell/soak/rehydrate steps
 *
 * Contract
 * { id, templateId, x-domain, x-version, title, params, inventory, preflightChecks, steps, timers,
 *   scheduleHints, safety, meta, actions, toPortable(), toGroceryList(), toFavoriteSeed(), withParams() }
 */

const VERSION = "1.0.0";
const DOMAIN = "garden";
const TEMPLATE_ID = "transplant-bed";

/* -------------------------------- Defaults --------------------------------- */
const DEFAULTS = {
  garden: { name: "Kitchen Garden" },

  bed: {
    label: "Bed A1",
    lengthFt: 10,          // bed length in feet
    widthFt: 3,            // bed width in feet
    rows: 1,               // 1 = single row, 2 = double row, 3+ = intensive
    orientation: "N-S",    // meta for UI only
  },

  crop: {
    name: "Tomato",
    family: "Solanaceae",       // used for rotation hints
    spacingIn: 18,              // in-row spacing (inches)
    rowSpacingIn: 24,           // between rows (inches) for multi-row beds
    transplantSize: "4in",      // plug size label (UI only)
    support: "stakes",          // none | stakes | cages | trellis
    frostTender: true,          // weather guardrails
    heatSensitive: false,
  },

  season: "spring",             // spring | summer | fall
  weather: { frostRisk: "low", hotSpell: "low", wind: "moderate" }, // UI guard

  irrigation: {
    method: "drip",             // drip | soaker | hand
    emittersPerPlant: 1,        // for drip
  },

  preferences: {
    ecoMode: true,
    sabbathGuard: false,
    quietHours: null,           // { startISO, endISO }
    sabbathRange: null,         // { startISO, endISO }
    labelFormat: "Bed Plant Variety Date",
  },

  mode: "standard",             // express | standard | thorough

  schedule: {
    preflight: "-0m",
    markRows: "+2m",
    amend: "+8m",
    layIrrigation: "+18m",
    preSoak: "+22m",
    transplant: "+30m",
    waterIn: "+50m",
    mulch: "+58m",
    supports: "+65m",
    cover: "+75m",
    cleanup: "+85m",
    record: "+90m",
  },
};

/* --------------------------------- Helpers ---------------------------------- */
const id = (parts) => parts.filter(Boolean).join(":");
const clamp = (n,a,b)=>Math.max(a,Math.min(b,n));
const toISO = (d)=>{ try { return new Date(d).toISOString(); } catch { return null; } };

const modeMultiplier = (mode) => mode === "express" ? 0.8 : mode === "thorough" ? 1.25 : 1.0;

// Basic geometry + conversion helpers
const ft2m = (ft) => ft * 0.3048;
const in2m = (inch) => inch * 0.0254;
const sqFt = (Lft, Wft) => Lft * Wft;

// Planting math
function calcPlantCapacity(bed, crop){
  const lengthM = ft2m(bed.lengthFt);
  const widthM  = ft2m(bed.widthFt);
  const inRowM = in2m(crop.spacingIn);
  const rowSpaceM = crop.rowSpacingIn ? in2m(crop.rowSpacingIn) : widthM / (bed.rows || 1);

  // rows fit within width; plants per row across the length
  const usableRows = Math.max(1, bed.rows || 1);
  const perRow = Math.max(1, Math.floor(lengthM / Math.max(inRowM, 0.15))); // guard min spacing ~15cm
  const total = perRow * usableRows;

  return { total, perRow, rows: usableRows, rowSpacingM: rowSpaceM, inRowM };
}

// Amendment calculators (quick heuristics)
function calcCompostCubicFt(areaSqFt){
  // ~1/2" layer = 0.0417 ft depth → area * 0.0417
  return Math.round(areaSqFt * 0.042);
}
function calcMulchCubicFt(areaSqFt){
  // ~1" mulch = 0.0833 ft depth
  return Math.round(areaSqFt * 0.083);
}

/* ------------------------------ Inventory Build ----------------------------- */
function buildInventory(params){
  const p = { ...DEFAULTS, ...params };
  const mm = modeMultiplier(p.mode);

  const area = sqFt(p.bed.lengthFt, p.bed.widthFt);
  const capacity = calcPlantCapacity(p.bed, p.crop);

  const inv = [];

  // Core consumables
  inv.push({ id:"compost", name:"Compost", qty: Math.max(1, Math.round(calcCompostCubicFt(area) * mm)), unit:"cubic-ft", aisle:"Garden", tags:["amendment","organic"] });
  inv.push({ id:"balanced-fertilizer", name:p.preferences.ecoMode ? "Organic Balanced Fertilizer" : "Balanced Fertilizer", qty: Math.ceil(area / 25), unit:"lb", aisle:"Garden", tags:["fertilizer", p.preferences.ecoMode?"organic":""] });
  inv.push({ id:"seedlings", name:`${p.crop.name} Seedlings`, qty: capacity.total, unit:"plants", aisle:"Nursery", tags:["transplant"] });
  inv.push({ id:"labels", name:"Plant Labels + Marker", qty: 1, unit:"set", aisle:"Office", tags:["label"] });

  // Irrigation
  if (p.irrigation.method === "drip") {
    const emitters = capacity.total * Math.max(1, p.irrigation.emittersPerPlant || 1);
    inv.push({ id:"dripline", name:"Drip Line/Kit", qty: Math.ceil(p.bed.lengthFt * p.bed.rows), unit:"ft", aisle:"Garden", tags:["irrigation","drip"] });
    inv.push({ id:"emitters", name:"Drip Emitters", qty: emitters, unit:"ea", aisle:"Garden", tags:["irrigation"] });
  } else if (p.irrigation.method === "soaker") {
    inv.push({ id:"soaker", name:"Soaker Hose", qty: Math.ceil(p.bed.lengthFt * p.bed.rows), unit:"ft", aisle:"Garden", tags:["irrigation","soaker"] });
  }

  // Mulch & coverings
  inv.push({ id:"mulch", name:"Mulch (straw/wood chips)", qty: Math.max(1, Math.round(calcMulchCubicFt(area) * mm)), unit:"cubic-ft", aisle:"Garden", tags:["mulch"] });

  // Supports
  if (p.crop.support === "stakes") {
    inv.push({ id:"stakes", name:"Tomato Stakes / Ties", qty: capacity.total, unit:"ea", aisle:"Garden", tags:["support"] });
    inv.push({ id:"tie-tape", name:"Soft Tie / Tape", qty: 1, unit:"roll", aisle:"Garden", tags:["support"] });
  } else if (p.crop.support === "cages") {
    inv.push({ id:"cages", name:"Plant Cages", qty: capacity.total, unit:"ea", aisle:"Garden", tags:["support"] });
  } else if (p.crop.support === "trellis") {
    inv.push({ id:"trellis", name:"Trellis Netting / T-Posts", qty: Math.max(2, p.bed.rows * 2), unit:"ea", aisle:"Garden", tags:["support"] });
  }

  // Frost/heat/wind protection
  if (p.crop.frostTender && p.season === "spring") {
    inv.push({ id:"row-cover", name:"Row Cover + Pins", qty: 1, unit:"set", aisle:"Garden", tags:["protection","frost"] });
  }
  if (p.weather.wind === "high") {
    inv.push({ id:"staples", name:"Fabric Staples / Pins", qty: 1, unit:"box", aisle:"Garden", tags:["protection","wind"] });
  }

  return inv;
}

/* ------------------------------- Preflight ---------------------------------- */
function buildPreflightChecks(params){
  const p = { ...DEFAULTS, ...params };
  const area = sqFt(p.bed.lengthFt, p.bed.widthFt);
  const capacity = calcPlantCapacity(p.bed, p.crop);

  const checks = [
    { id:"soil-temp", label:"Soil ≥ 55°F (13°C) for warm crops", kind:"sensor", mustBe: !p.crop.frostTender ? true : undefined, optional: !p.crop.frostTender },
    { id:"compost", label:"Compost on hand", kind:"inventory", minQty: Math.max(1, Math.round(calcCompostCubicFt(area))), unit:"cubic-ft" },
    { id:"seedlings", label:"Seedlings count meets capacity", kind:"inventory", minQty: capacity.total, unit:"plants" },
    { id:"labels", label:"Labels & marker ready", kind:"inventory", minQty: 1, unit:"set" },
  ];

  if (p.irrigation.method === "drip") {
    checks.push({ id:"dripline", label:"Drip line length available", kind:"inventory", minQty: Math.ceil(p.bed.lengthFt * p.bed.rows), unit:"ft" });
    checks.push({ id:"emitters", label:"Emitters available", kind:"inventory", minQty: capacity.total * Math.max(1, p.irrigation.emittersPerPlant || 1), unit:"ea" });
  }
  if (p.irrigation.method === "soaker") {
    checks.push({ id:"soaker", label:"Soaker hose length available", kind:"inventory", minQty: Math.ceil(p.bed.lengthFt * p.bed.rows), unit:"ft" });
  }
  if (p.crop.support === "stakes") checks.push({ id:"stakes", label:"Stakes available", kind:"inventory", minQty: capacity.total, unit:"ea" });
  if (p.crop.support === "cages")  checks.push({ id:"cages",  label:"Cages available",  kind:"inventory", minQty: capacity.total, unit:"ea" });
  if (p.crop.support === "trellis") checks.push({ id:"trellis", label:"Trellis/Posts available", kind:"inventory", minQty: Math.max(2, p.bed.rows * 2), unit:"ea" });

  if (p.crop.frostTender && p.season === "spring") {
    checks.push({ id:"row-cover", label:"Row cover available", kind:"inventory", minQty: 1, unit:"set" });
  }

  return checks;
}

/* --------------------------------- Steps ------------------------------------ */
function stepsFor(params){
  const p = { ...DEFAULTS, ...params };
  const s = p.schedule;
  const mm = modeMultiplier(p.mode);
  const cap = calcPlantCapacity(p.bed, p.crop);

  const steps = [];

  steps.push({
    id:"preflight",
    title:"Preflight & Bed Scan",
    offset: s.preflight,
    duration: Math.round(3 * mm) + "m",
    kind:"setup",
    instructions:[
      `Bed: ${p.bed.label} (${p.bed.lengthFt}×${p.bed.widthFt} ft). Crop: ${p.crop.name}.`,
      "Remove debris; check irrigation connection; confirm soil is workable (not waterlogged).",
      p.crop.frostTender ? "If frost risk today or tonight, delay or have row cover ready." : null
    ].filter(Boolean),
    signals:[{ type:"ui/progress", value:0.05 }]
  });

  steps.push({
    id:"mark-rows",
    title:"String Lines & Mark Rows",
    offset: s.markRows,
    duration: Math.round(6 * mm) + "m",
    kind:"layout",
    instructions:[
      `Set ${cap.rows} row(s); in-row spacing ≈ ${p.crop.spacingIn}" (≈${cap.inRowM.toFixed(2)} m).`,
      "Mark holes with dibble or trowel at spacing intervals."
    ],
    signals:[{ type:"ui/progress", value:0.15 }]
  });

  steps.push({
    id:"amend",
    title:"Amend & Rake Smooth",
    offset: s.amend,
    duration: Math.round(10 * mm) + "m",
    kind:"amend",
    instructions:[
      "Broadcast compost evenly (~½\" layer); rake level.",
      "Apply balanced fertilizer per label; mix into top 2\" of soil."
    ],
    reminders:[{ kind:"timer", label:"Soil Settle Pause", minutes: 5 }],
    signals:[{ type:"ui/progress", value:0.3 }]
  });

  if (p.irrigation.method !== "hand") {
    steps.push({
      id:"lay-irrigation",
      title:"Lay Irrigation",
      offset: s.layIrrigation,
      duration: Math.round(6 * mm) + "m",
      kind:"irrigation",
      instructions:[
        p.irrigation.method === "drip"
          ? `Run drip line along each row; place ${Math.max(1, p.irrigation.emittersPerPlant)} emitter(s) per planting site.`
          : "Lay soaker hose along each row.",
        "Connect to header; test for leaks."
      ]
    });
  }

  steps.push({
    id:"pre-soak",
    title:"Pre-Soak Seedlings",
    offset: s.preSoak,
    duration: "5m",
    kind:"prep",
    instructions:[
      "Water seedlings in trays so rootballs are moist and flexible.",
      "Shade trays while working."
    ],
    reminders:[{ kind:"timer", label:"Pre-Soak", minutes:5 }],
    signals:[{ type:"ui/progress", value:0.45 }]
  });

  steps.push({
    id:"transplant",
    title:"Transplant — Set at Depth, Firm In",
    offset: s.transplant,
    duration: Math.max(8, Math.round((cap.total * 0.75) * mm)) + "m",
    kind:"plant",
    instructions:[
      "Loosen rootball; set slightly deeper for leggy tomatoes (bury stem), level for others.",
      "Firm soil around crown; avoid burying leaves.",
      "Place label per plant or per row."
    ],
    signals:[{ type:"ui/progress", value:0.7 }]
  });

  steps.push({
    id:"water-in",
    title:"Water In",
    offset: s.waterIn,
    duration: Math.round(6 * mm) + "m",
    kind:"irrigation",
    instructions:[
      p.irrigation.method === "hand" ? "Hand-water each plant until root zone is saturated." : "Run drip/soaker until soil is moist to 6\" depth.",
      "Add a mild transplant solution if desired (per label)."
    ],
    reminders:[{ kind:"timer", label:"Irrigation Cycle", minutes: 10 }],
  });

  steps.push({
    id:"mulch",
    title:"Mulch to Hold Moisture",
    offset: s.mulch,
    duration: Math.round(6 * mm) + "m",
    kind:"mulch",
    instructions:[
      "Mulch 1\" around plants, leaving a small gap around stems.",
      "Top up pathways if needed."
    ],
    signals:[{ type:"ui/progress", value:0.85 }]
  });

  if (p.crop.support && p.crop.support !== "none") {
    steps.push({
      id:"supports",
      title:"Install Supports",
      offset: s.supports,
      duration: Math.round(8 * mm) + "m",
      kind:"support",
      instructions:[
        p.crop.support === "stakes" ? "Drive stakes 8–12\" deep; tie loosely with soft tie." :
        p.crop.support === "cages"  ? "Place cages now while plants are small." :
        "Stretch trellis netting between posts; clip vines as they grow."
      ]
    });
  }

  if ((p.crop.frostTender && p.season === "spring") || p.weather.wind === "high") {
    steps.push({
      id:"cover",
      title:"Add Row Cover / Wind Protection",
      offset: s.cover,
      duration: Math.round(5 * mm) + "m",
      kind:"protection",
      instructions:[
        "Drape row cover over hoops; pin or staple edges.",
        "Vent warm afternoons to avoid overheating."
      ]
    });
  }

  steps.push({
    id:"cleanup",
    title:"Cleanup & Tools Away",
    offset: s.cleanup,
    duration: Math.round(4 * mm) + "m",
    kind:"reset",
    instructions:[
      "Collect trays, markers, and tools; coil hoses/lines neatly."
    ],
  });

  steps.push({
    id:"record",
    title:"Record Planting",
    offset: s.record,
    duration: "3m",
    kind:"record",
    instructions:[
      `Log ${cap.total} plants of ${p.crop.name} in ${p.bed.label}.`,
      "Note spacing, support, irrigation method, and any weather notes."
    ],
    signals:[{ type:"ui/progress", value:1 }]
  });

  return steps;
}

/* -------------------------------- Timers ------------------------------------ */
function timersFor(params){
  const p = { ...DEFAULTS, ...params };
  const t = [
    { id:"seedlings.presoak", label:"Pre-Soak Seedlings", minutes:5 },
  ];
  if (p.irrigation.method !== "hand") t.push({ id:"irrigation.cycle", label:"Irrigation Cycle", minutes:10 });
  return t;
}

/* ---------------------------- Schedule Hints -------------------------------- */
function scheduleHintsFor(params){
  const p = { ...DEFAULTS, ...params };
  const hints = [
    { kind:"appliance", name:"irrigation", window:"session", exclusive:false },
  ];
  if (p.preferences.quietHours?.startISO && p.preferences.quietHours?.endISO) {
    hints.push({ kind:"withholdAbsolute", start: toISO(p.preferences.quietHours.startISO), end: toISO(p.preferences.quietHours.endISO), reason:"quiet-hours" });
  }
  if (p.preferences.sabbathGuard && p.preferences.sabbathRange?.startISO && p.preferences.sabbathRange?.endISO){
    hints.push({ kind:"withholdAbsolute", start: toISO(p.preferences.sabbathRange.startISO), end: toISO(p.preferences.sabbathRange.endISO), reason:"sabbath-no-work" });
  }
  // Weather guardrails for frost-tender crops
  if (p.crop.frostTender && p.season === "spring" && p.weather.frostRisk === "high") {
    hints.push({ kind:"advisory", level:"warning", message:"High frost risk — delay or use row cover/low tunnel." });
  }
  if (p.crop.heatSensitive && p.weather.hotSpell === "high") {
    hints.push({ kind:"advisory", level:"warning", message:"Heat spell — transplant early morning/evening and provide shade." });
  }
  if (p.weather.wind === "high") {
    hints.push({ kind:"advisory", level:"info", message:"High wind — secure row cover; water in thoroughly." });
  }
  return hints;
}

/* --------------------------------- Factory ---------------------------------- */
export function createTransplantBedPlan(params = {}){
  const p = { ...DEFAULTS, ...params };
  const cap = calcPlantCapacity(p.bed, p.crop);

  const planId = id([
    "gardenplan",
    TEMPLATE_ID,
    p.bed.label,
    p.crop.name.replace(/\s+/g,"-").toLowerCase(),
    `${cap.total}ct`
  ]);

  const plan = {
    id: planId,
    templateId: TEMPLATE_ID,
    "x-domain": DOMAIN,
    "x-version": VERSION,

    title: `Transplant — ${p.crop.name} in ${p.bed.label}`,
    description: "Adaptive bed transplant with spacing, irrigation, mulch, supports, and protection—weather-aware and savable.",
    tags: ["garden","transplant", p.crop.name, p.season, p.irrigation.method, p.crop.support].filter(Boolean),

    params: p,
    resources: {
      equipment: [
        "Trowel/Dibble", "Rake", "Watering Can/Hose",
        p.irrigation.method !== "hand" && "Drip/Soaker Kit",
        (p.crop.support && p.crop.support !== "none") && "Supports",
        (p.crop.frostTender && p.season === "spring") && "Row Cover"
      ].filter(Boolean),
      references: [
        { label:"Plant Capacity", notes:`Rows: ${cap.rows}, Plants/row: ${cap.perRow}, Total: ${cap.total}` }
      ]
    },

    inventory: buildInventory(p),
    preflightChecks: buildPreflightChecks(p),

    steps: stepsFor(p),
    timers: timersFor(p),
    scheduleHints: scheduleHintsFor(p),

    safety: { ppe:[], ventilation:false },

    meta: {
      savable: true,
      favoriteable: true,
      authoring: { canFork: true, forkLabel: "Save your transplant plan" },
      share: { portable: true },
      ui: { chips: [p.bed.label, p.crop.name, p.mode, p.irrigation.method].filter(Boolean) }
    },

    actions: [
      { id:"open-spacing-grid", label:"Open Spacing Grid", kind:"ui", payload:{ bed: p.bed, crop: p.crop } },
      { id:"start-timers", label:"Start Session Timers", kind:"session", payload:{ start:true } },
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
      return createTransplantBedPlan({ ...this.params, ...patch });
    }
  };

  // Orchestration: let app react (inventory checks, reminders, weather tips)
  try {
    const bus = (typeof window !== "undefined" && window.__suka_eventBus__) || null;
    bus?.emit?.("workplan.created", {
      domain: DOMAIN, templateId: TEMPLATE_ID, id: plan.id, params: p
    });
  } catch {}

  return plan;
}

/* -------------------------- Template Override Hook -------------------------- */
export async function getTransplantBedPlan(params = {}){
  try {
    const T = await import(/* @vite-ignore */ "@/libraries/GardenPlanTemplates");
    const api = T?.default ?? T;
    if (api?.get) {
      const external = await api.get(TEMPLATE_ID, params);
      if (external) return external;
    }
  } catch { /* optional */ }
  return createTransplantBedPlan(params);
}

/* --------------------------------- Export ----------------------------------- */
export default {
  id: TEMPLATE_ID,
  domain: DOMAIN,
  version: VERSION,
  defaults: DEFAULTS,
  create: createTransplantBedPlan,
  get: getTransplantBedPlan,
};
