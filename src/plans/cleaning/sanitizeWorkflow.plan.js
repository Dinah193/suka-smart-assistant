// src/plans/cleaning/sanitizeWorkflow.plan.js
/* eslint-disable no-console */
/**
 * sanitizeWorkflow.plan.js — Adaptive sanitizing routine for home zones
 *
 * Design goals
 * - Dynamic to scenario (everyday | flu-like | stomach | food-spill), rooms/zones, eco/fragrance prefs
 * - Preflight supply checks that pair with InventoryMonitor (offer “add to list”)
 * - Clear phases with offsets + timers for SessionHUD / MultiTimer
 * - Quiet hours & Sabbath guard with absolute withhold windows
 * - Users can FAVORITE or fork their own version (portable payload + seed)
 *
 * Contract
 * { id, templateId, x-domain, x-version, title, params, inventory, preflightChecks, steps, timers,
 *   scheduleHints, safety, meta, actions, toPortable(), toGroceryList(), toFavoriteSeed(), withParams() }
 */

const VERSION = "1.1.0";
const DOMAIN = "cleaning";
const TEMPLATE_ID = "sanitize-workflow";

/* -------------------------------- Defaults --------------------------------- */
const DEFAULTS = {
  home: { occupants: 4, pets: 1 },

  scenario: "everyday",   // everyday | flu | stomach | food-spill
  // rooms/zones toggles
  zones: {
    kitchen: true,
    bathrooms: true,
    bedrooms: true,
    commonAreas: true,        // doors, remotes, rails, switches
    laundry: true,            // linens/towels
  },

  preferences: {
    ecoMode: true,
    fragranceFree: true,
    sabbathGuard: false,
    quietHours: null,         // { startISO, endISO }
    sabbathRange: null,       // { startISO, endISO }
  },

  // Disinfectant settings, contact time in minutes (UI can surface label on step)
  disinfectant: {
    kind: "disinfectant-spray", // disinfectant-spray | wipes | peroxide | diluted-bleach
    contactMinutes: 5,          // set higher (8–10) for stomach scenario
    dilutionRatio: "per label", // meta only (for display)
  },

  // Mode influences scope and pace
  mode: "standard", // express | standard | intensive

  // Offsets relative to session start (durations scale; offsets keep rhythm)
  schedule: {
    preflight: "-0m",
    declutter: "+2m",
    highTouch: "+6m",
    kitchen: "+14m",
    bathrooms: "+24m",
    bedrooms: "+36m",
    laundry: "+44m",
    airRefresh: "+48m",
    reset: "+52m",
  },
};

/* --------------------------------- Helpers ---------------------------------- */
const id = (parts) => parts.filter(Boolean).join(":");
const clamp = (n,a,b)=>Math.max(a,Math.min(b,n));
const toISO = (d)=>{ try { return new Date(d).toISOString(); } catch { return null; } };

const modeMultiplier = (mode) => mode === "express" ? 0.75 : mode === "intensive" ? 1.35 : 1.0;
const scenarioMultiplier = (sc) =>
  sc === "flu" ? 1.2 : sc === "stomach" ? 1.35 : sc === "food-spill" ? 1.15 : 1.0;

const scaled = (base, mode, scenario) =>
  Math.max(1, Math.round(base * modeMultiplier(mode) * scenarioMultiplier(scenario)));

/* ------------------------------ Inventory Build ----------------------------- */
/**
 * Consumables & PPE sized for a single session. InventoryMonitor will surface
 * “low” or “short” and your grocery flow can draft a list from these lines.
 */
function buildInventory(params){
  const p = { ...DEFAULTS, ...params };
  const inv = [];
  const more = p.mode === "intensive" || p.scenario !== "everyday";

  // Core
  inv.push({ id:"microfiber-10", name:"Microfiber Cloths", qty: more ? 12 : 8, unit:"ea", aisle:"Cleaning", tags:["cloths"] });
  inv.push({ id:"gloves-nitrile", name:"Nitrile Gloves", qty:1, unit:"box", aisle:"Health", tags:["ppe","gloves"] });
  inv.push({ id:"trash-bags", name:"Trash Bags", qty:1, unit:"roll", aisle:"Household", tags:["trash"] });

  // Disinfectant lines (eco/fragrance-aware)
  const addDisinfectant = () => {
    const eco = !!p.preferences.ecoMode;
    const ff  = !!p.preferences.fragranceFree;
    const contact = clamp(Number(p.disinfectant?.contactMinutes) || 5, 2, 15);

    if (p.disinfectant.kind === "wipes") {
      inv.push({ id:"disinfectant-wipes-ff", name: ff ? "Disinfecting Wipes (Fragrance Free)" : "Disinfecting Wipes", qty: more ? 3 : 2, unit:"tubs", aisle:"Cleaning", tags:["disinfect","wipes", ff ? "fragrance-free":""] });
    } else if (p.disinfectant.kind === "peroxide") {
      inv.push({ id:"peroxide-disinfectant", name:"Peroxide-Based Disinfectant", qty: more ? 1000 : 700, unit:"ml", aisle:"Cleaning", tags:["disinfect","peroxide"], notes:`Contact ${contact}m` });
    } else if (p.disinfectant.kind === "diluted-bleach") {
      inv.push({ id:"bleach", name:"Household Bleach (for dilution)", qty: more ? 1000 : 700, unit:"ml", aisle:"Cleaning", tags:["disinfect","bleach"], notes:`Dilution ${p.disinfectant?.dilutionRatio||"per label"}; Contact ${contact}m` });
  } else {
      inv.push({ id: eco ? "disinfectant-spray-eco" : "disinfectant-spray", name: eco ? "Plant-Based Disinfectant Spray" : "Disinfectant Spray", qty: more ? 1000 : 700, unit:"ml", aisle:"Cleaning", tags:["disinfect", eco ? "eco":""], notes:`Contact ${contact}m` });
    }
  };
  addDisinfectant();

  // Bathroom/kitchen extras
  if (p.zones.bathrooms) inv.push({ id:"toilet-bowl", name:"Toilet Bowl Cleaner (Fume Free)", qty:1, unit:"bottle", aisle:"Cleaning", tags:["bathroom"] });
  if (p.zones.kitchen)   inv.push({ id:"all-purpose", name:p.preferences.ecoMode ? "All-Purpose Cleaner (Fragrance Free)" : "All-Purpose Cleaner", qty: p.mode === "intensive" ? 900 : 600, unit:"ml", aisle:"Cleaning", tags:["surface", p.preferences.ecoMode ? "eco":"", p.preferences.fragranceFree ? "fragrance-free":""].filter(Boolean) });

  // Laundry (for linens/towels)
  if (p.zones.laundry) {
    inv.push({ id:"laundry-detergent", name:p.preferences.fragranceFree ? "Detergent (Fragrance Free)" : "Laundry Detergent", qty:1, unit:"bottle", aisle:"Cleaning", tags:["laundry"] });
    inv.push({ id:"oxygen-boost", name:"Oxygen Booster (optional)", qty:1, unit:"bag", aisle:"Cleaning", tags:["laundry","booster"] });
  }

  return inv;
}

/* ------------------------------- Preflight ---------------------------------- */
function buildPreflightChecks(params){
  const p = { ...DEFAULTS, ...params };
  const checks = [
    { id:"gloves-nitrile", label:"Gloves available", kind:"inventory", minQty: 1, unit:"box" },
    { id:"microfiber-10", label:"Microfiber cloths ready", kind:"inventory", minQty: 6, unit:"ea" },
  ];
  // Disinfectant (use presence, not brand)
  if (p.disinfectant.kind === "wipes") {
    checks.push({ id:"disinfectant-wipes-ff", label:"Disinfecting wipes on hand", kind:"inventory", minQty: 1, unit:"tubs" });
  } else if (p.disinfectant.kind === "peroxide") {
    checks.push({ id:"peroxide-disinfectant", label:"Peroxide disinfectant on hand", kind:"inventory", minQty: 200, unit:"ml" });
  } else if (p.disinfectant.kind === "diluted-bleach") {
    checks.push({ id:"bleach", label:"Bleach available for dilution", kind:"inventory", minQty: 200, unit:"ml" });
  } else {
    checks.push({ id:"disinfectant-spray", label:"Disinfectant spray on hand", kind:"inventory", minQty: 200, unit:"ml", optional: !!p.preferences.ecoMode });
    checks.push({ id:"disinfectant-spray-eco", label:"Plant-based disinfectant on hand", kind:"inventory", minQty: 200, unit:"ml", optional: !p.preferences.ecoMode });
  }
  if (p.zones.kitchen) checks.push({ id:"all-purpose", label:"All-purpose cleaner", kind:"inventory", minQty: 200, unit:"ml" });
  if (p.zones.laundry) checks.push({ id:"laundry-detergent", label:"Laundry detergent", kind:"inventory", minQty: 1, unit:"bottle" });

  return checks;
}

/* --------------------------------- Steps ------------------------------------ */
function stepsFor(params){
  const p = { ...DEFAULTS, ...params };
  const s = p.schedule;
  const contact = clamp(Number(p.disinfectant?.contactMinutes) || 5, 2, 15);
  const steps = [];

  // 0) Preflight & PPE
  steps.push({
    id:"preflight",
    title:"Preflight & PPE",
    offset: s.preflight,
    duration: scaled(3, p.mode, p.scenario) + "m",
    kind:"setup",
    instructions:[
      "Open window / start ventilation.",
      "Put on nitrile gloves.",
      "Stage clean & used cloth bins."
    ],
    signals:[{ type:"ui/progress", value:0.05 }]
  });

  // 1) Fast Declutter
  steps.push({
    id:"declutter",
    title:"Rapid Declutter",
    offset: s.declutter,
    duration: scaled(5, p.mode, p.scenario) + "m",
    kind:"prep",
    instructions:[
      "Collect dishes, trash, and laundry from target zones.",
      "Bag trash; start dishwasher if full."
    ],
    reminders:[{ kind:"timer", label:"Declutter Sprint", minutes: scaled(5, p.mode, p.scenario) }]
  });

  // 2) High-Touch Disinfect
  if (p.zones.commonAreas) {
    steps.push({
      id:"high-touch",
      title:`High-Touch Disinfect (contact ${contact}m)`,
      offset: s.highTouch,
      duration: scaled(10, p.mode, p.scenario) + "m",
      kind:"sanitize",
      instructions:[
        "Spray/wipe: doorknobs, railings, switches, remotes, keyboards, phones.",
        `Ensure surfaces stay visibly wet for ${contact} minutes (reapply if drying).`
      ],
      reminders:[{ kind:"timer", label:"Contact Time — High Touch", minutes: contact }],
      signals:[{ type:"ui/progress", value:0.25 }]
    });
  }

  // 3) Kitchen Zone
  if (p.zones.kitchen) {
    const base = p.scenario === "food-spill" ? 14 : 10;
    steps.push({
      id:"kitchen",
      title:`Kitchen Surfaces (contact ${contact}m)`,
      offset: s.kitchen,
      duration: scaled(base, p.mode, p.scenario) + "m",
      kind:"sanitize",
      instructions:[
        "Pre-clean crumbs/grease (all-purpose).",
        "Disinfect: counters, sink fixtures, appliance handles.",
        p.scenario === "food-spill" ? "Focus spill zone: cutting boards, knives, and adjacent counters." : null,
        `Leave wet for ${contact} minutes; then wipe dry if needed.`
      ].filter(Boolean),
      reminders:[{ kind:"timer", label:"Contact Time — Kitchen", minutes: contact }],
      signals:[{ type:"ui/progress", value:0.45 }]
    });
  }

  // 4) Bathrooms
  if (p.zones.bathrooms) {
    const base = p.scenario === "stomach" ? 16 : 12;
    steps.push({
      id:"bathrooms",
      title:`Bathrooms: Fixtures & Touchpoints (contact ${contact}m)`,
      offset: s.bathrooms,
      duration: scaled(base, p.mode, p.scenario) + "m",
      kind:"sanitize",
      instructions:[
        "Toilet flush handle, seat & lid (top → underside), faucet handles, sink rim.",
        "Disinfect door handles & light switches.",
        `Maintain ${contact}m contact time before dry buff if needed.`,
      ],
      reminders:[{ kind:"timer", label:"Contact Time — Bathrooms", minutes: contact }],
      safety:{ ppe:["gloves-nitrile"] },
      signals:[{ type:"ui/progress", value:0.7 }]
    });
  }

  // 5) Bedrooms quick pass
  if (p.zones.bedrooms) {
    steps.push({
      id:"bedrooms",
      title:"Bedrooms: Touchpoints & Nightstands",
      offset: s.bedrooms,
      duration: scaled(8, p.mode, p.scenario) + "m",
      kind:"sanitize",
      instructions:[
        "Nightstand tops, drawer pulls, lamp switches, door handles.",
        "Air out room briefly if possible."
      ]
    });
  }

  // 6) Laundry (linens/towels)
  if (p.zones.laundry) {
    steps.push({
      id:"laundry",
      title:"Laundry: Linens & Towels",
      offset: s.laundry,
      duration: scaled(4, p.mode, p.scenario) + "m",
      kind:"laundry",
      instructions:[
        "Load linens/towels. Use warm or hot as fabric allows.",
        "Optional: oxygen booster per label.",
      ],
      reminders:[{ kind:"timer", label:"Switch to Dryer Reminder", minutes: 45 }],
      signals:[{ type:"ui/progress", value:0.85 }]
    });
  }

  // 7) Air refresh / ventilation
  steps.push({
    id:"air.refresh",
    title:"Air Refresh",
    offset: s.airRefresh,
    duration: "3m",
    kind:"ventilation",
    instructions:[
      "Open windows briefly / run exhaust fan.",
      "Leave interior doors ajar for cross-flow."
    ],
  });

  // 8) Reset & finish
  steps.push({
    id:"reset",
    title:"Reset & Final Scan",
    offset: s.reset,
    duration: "2m",
    kind:"reset",
    instructions:[
      "Collect used cloths to laundry; remove gloves; wash hands.",
      "Lights off. Done."
    ],
    signals:[{ type:"ui/progress", value:1 }]
  });

  return steps;
}

/* -------------------------------- Timers ------------------------------------ */
function timersFor(params){
  const p = { ...DEFAULTS, ...params };
  const t = [];
  const contact = clamp(Number(p.disinfectant?.contactMinutes) || 5, 2, 15);

  if (p.zones.commonAreas) t.push({ id:"contact.highTouch", label:"Contact: High Touch", minutes: contact });
  if (p.zones.kitchen)     t.push({ id:"contact.kitchen",   label:"Contact: Kitchen",   minutes: contact });
  if (p.zones.bathrooms)   t.push({ id:"contact.bath",      label:"Contact: Bathrooms", minutes: contact });
  if (p.zones.laundry)     t.push({ id:"laundry.switch",    label:"Switch to Dryer",    minutes: 45 });

  return t;
}

/* ---------------------------- Schedule Hints -------------------------------- */
function scheduleHintsFor(params){
  const p = { ...DEFAULTS, ...params };
  const hints = [
    { kind:"biohazard", rule:"chemical-gloves-required" },
    { kind:"ventilation", window:"session" },
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
export function createSanitizeWorkflowPlan(params = {}){
  const p = { ...DEFAULTS, ...params };
  const planId = id([
    "cleanplan",
    TEMPLATE_ID,
    p.mode,
    p.scenario,
    p.preferences.ecoMode ? "eco":"std"
  ]);

  const plan = {
    id: planId,
    templateId: TEMPLATE_ID,
    "x-domain": DOMAIN,
    "x-version": VERSION,

    title:
      p.mode === "express" ? "Sanitize Workflow — Express (≈20–30m)" :
      p.mode === "intensive" ? "Sanitize Workflow — Intensive (≈50–70m)" :
      "Sanitize Workflow — Standard (≈35–50m)",

    description: "Adaptive sanitizing routine for high-touch zones, kitchen, baths, bedrooms, and linens—contact times included, quiet-hour/Sabbath aware.",
    tags: ["cleaning","sanitize", p.mode, p.scenario, p.preferences.ecoMode ? "eco" : "standard"],

    params: p,

    resources: {
      equipment: [
        "Microfiber cloths", "Nitrile gloves", "Disinfectant",
        p.zones.laundry && "Washer/Dryer",
        "Trash bags"
      ].filter(Boolean),
      references: [
        { label: "Contact time", notes: `${clamp(Number(p.disinfectant?.contactMinutes)||5,2,15)} minutes (keep surface visibly wet)` }
      ]
    },

    inventory: buildInventory(p),
    preflightChecks: buildPreflightChecks(p),

    steps: stepsFor(p),
    timers: timersFor(p),
    scheduleHints: scheduleHintsFor(p),

    safety: { ppe:["gloves-nitrile"], ventilation:true },

    meta: {
      savable: true,
      favoriteable: true,
      authoring: { canFork: true, forkLabel: "Save your sanitize workflow" },
      share: { portable: true },
      ui: { chips: [p.mode, p.scenario, p.preferences.ecoMode ? "eco":"std"].filter(Boolean) }
    },

    // Optional quick actions for the runtime UI
    actions: [
      { id:"start-timers", label:"Start Contact Timers", kind:"session", payload:{ start:true } },
      { id:"open-checklist", label:"Open Checklist", kind:"ui", payload:{ section:"sanitize" } },
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
      return createSanitizeWorkflowPlan({ ...this.params, ...patch });
    }
  };

  // Emit creation for orchestration (grocery draft, reminders, etc.)
  try {
    const bus = (typeof window !== "undefined" && window.__suka_eventBus__) || null;
    bus?.emit?.("workplan.created", { domain: DOMAIN, templateId: TEMPLATE_ID, id: plan.id, params: p });
  } catch {}

  return plan;
}

/* -------------------------- Template Override Hook -------------------------- */
export async function getSanitizeWorkflowPlan(params = {}){
  try {
    const T = await import(/* @vite-ignore */ "@/libraries/CleanPlanTemplates");
    const api = T?.default ?? T;
    if (api?.get) {
      const external = await api.get(TEMPLATE_ID, params);
      if (external) return external;
    }
  } catch { /* optional */ }
  return createSanitizeWorkflowPlan(params);
}

/* --------------------------------- Export ----------------------------------- */
export default {
  id: TEMPLATE_ID,
  domain: DOMAIN,
  version: VERSION,
  defaults: DEFAULTS,
  create: createSanitizeWorkflowPlan,
  get: getSanitizeWorkflowPlan,
};
