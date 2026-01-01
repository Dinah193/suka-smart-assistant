// src/plans/cleaning/quickCleanKitchen.plan.js
/* eslint-disable no-console */
/**
 * quickCleanKitchen.plan.js — 20–45 minute kitchen reset (Express / Standard / Deep)
 *
 * Goals
 * - Fast, focused routine users can FAVORITE or fork (portable save payloads)
 * - Dynamic to size, cleanliness, eco/fragrance prefs, quiet hours, Sabbath guard
 * - Mode selector (express ~20m, standard ~30m, deep ~45m) + adaptive durations
 * - Zone toggles; tight steps with offsets & timers for SessionHUD / MultiTimer
 * - Preflight checks (consumables/tools) for InventoryMonitor surfaces
 * - Namespaced events; shared orchestration friendly
 *
 * Contract
 * { id, templateId, x-domain, x-version, title, params, inventory, steps, timers,
 *   scheduleHints, safety, meta, preflightChecks, actions, toPortable(), toGroceryList(),
 *   toFavoriteSeed(), withParams() }
 */

const VERSION = "1.2.0";
const DOMAIN = "cleaning";
const TEMPLATE_ID = "quick-clean-kitchen-30";

/* -------------------------------- Defaults --------------------------------- */
const DEFAULTS = {
  home: { occupants: 4, pets: 1 },

  kitchen: {
    size: "medium",           // small | medium | large
    hasDishwasher: true,
    floorType: "tile",        // tile | vinyl | wood | stone
  },

  preferences: {
    ecoMode: true,
    fragranceFree: true,
    sabbathGuard: false,
    // absolute withhold window (optional): { startISO, endISO }
    quietHours: null,
  },

  // How dirty is it? rough 0..5 scale influences durations
  cleanlinessScore: 2,        // 0=already tidy … 5=messy

  // Mode tunes the pacing & scope
  mode: "standard",           // express | standard | deep

  // Zones / focus areas
  focusAreas: {
    dishes: true,
    hotspots: true,           // handles, switches, fridge pull
    counters: true,
    microwave: true,
    sink: true,
    spotSweep: true,
    trash: true,
  },

  // If guestsComing, add a tiny polish step & tighten pacing
  guestsComing: false,

  // Offsets relative to session start; negative means “immediately”
  // Mode multipliers will compress/expand durations, not offsets.
  schedule: {
    declutter: "-0m",
    dishes: "+2m",
    hotspots: "+8m",
    counters: "+14m",
    microwave: "+18m",
    sink: "+22m",
    spotSweep: "+25m",
    trash: "+28m",
    reset: "+29m",
  },
};

/* --------------------------------- Helpers ---------------------------------- */
const id = (parts) => parts.filter(Boolean).join(":");
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));

const modeMultiplier = (mode) =>
  mode === "express" ? 0.75 : mode === "deep" ? 1.4 : 1.0;

const cleanlinessMultiplier = (score) =>
  // light mess speeds up slightly, heavy slows down; 0..5 → 0.85..1.35
  0.85 + clamp(Number(score) || 0, 0, 5) * ((1.35 - 0.85) / 5);

const scaledMinutes = (size, base, mode, score) => {
  const sizeScale = size === "small" ? 0.85 : size === "large" ? 1.2 : 1.0;
  const mm = modeMultiplier(mode);
  const cm = cleanlinessMultiplier(score);
  return Math.max(1, Math.round(base * sizeScale * mm * cm));
};

const toISO = (d) => { try { return new Date(d).toISOString(); } catch { return null; } };

/* ------------------------------ Inventory Build ----------------------------- */
/**
 * Minimal consumables list that plugs into InventoryMonitor + grocery list.
 * Quantities are generous one-session estimates and scale with mode.
 */
function buildInventory(params){
  const p = { ...DEFAULTS, ...params };
  const inv = [];

  const modeQty = (ml) => Math.round(
    (p.mode === "express" ? ml * 0.7 : p.mode === "deep" ? ml * 1.3 : ml)
  );

  inv.push({ id:"microfiber-6", name:"Microfiber Cloths", qty: p.mode === "deep" ? 8 : 6, unit:"ea", aisle:"Cleaning", tags:["cloths"] });

  if (p.preferences.ecoMode) {
    inv.push({ id:"all-purpose-eco", name:"All-Purpose Cleaner (Fragrance Free)", qty: modeQty(700), unit:"ml", aisle:"Cleaning", tags:["surface","eco","fragrance-free"] });
  } else {
    inv.push({ id:"all-purpose", name:"All-Purpose Cleaner", qty: modeQty(700), unit:"ml", aisle:"Cleaning", tags:["surface"] });
    if (p.preferences.fragranceFree) inv.push({ id:"ff-wipes", name:"Fragrance-Free Surface Wipes", qty:1, unit:"pack", aisle:"Cleaning", tags:["wipes","fragrance-free"] });
  }

  if (p.kitchen.hasDishwasher && p.focusAreas.dishes) {
    inv.push({ id:"dish-tabs", name:"Dishwasher Tabs", qty:1, unit:"box", aisle:"Cleaning", tags:["dishwasher"] });
    inv.push({ id:"rinse-aid", name:"Rinse Aid", qty:1, unit:"bottle", aisle:"Cleaning", tags:["dishwasher"] });
  }

  if (p.focusAreas.trash) {
    inv.push({ id:"trash-bags", name:"Trash Bags", qty:1, unit:"roll", aisle:"Household", tags:["trash"] });
  }

  return inv;
}

/* ------------------------------- Preflight ---------------------------------- */
/**
 * Preflight checks allow the UI to nudge the user if key supplies are low.
 * Orchestration can cross-check InventoryMonitor signals and surface “Add to list”.
 */
function buildPreflightChecks(params){
  const p = { ...DEFAULTS, ...params };
  const checks = [
    { id:"microfiber-6", label:"Microfiber cloths available", kind:"inventory", minQty: 4, unit:"ea" },
    { id:"all-purpose-eco", label:"Surface cleaner available", kind:"inventory", minQty: 200, unit:"ml", optional: !p.preferences.ecoMode },
    { id:"all-purpose", label:"Surface cleaner available", kind:"inventory", minQty: 200, unit:"ml", optional: p.preferences.ecoMode },
  ];
  if (p.kitchen.hasDishwasher && p.focusAreas.dishes) {
    checks.push({ id:"dish-tabs", label:"Dishwasher tabs", kind:"inventory", minQty: 2, unit:"ea" });
    checks.push({ id:"rinse-aid", label:"Rinse aid", kind:"inventory", minQty: 50, unit:"ml" });
  }
  if (p.focusAreas.trash) {
    checks.push({ id:"trash-bags", label:"Trash bags", kind:"inventory", minQty: 1, unit:"roll" });
  }
  return checks;
}

/* --------------------------------- Steps ------------------------------------ */
function stepsFor(params){
  const p = { ...DEFAULTS, ...params };
  const s = p.schedule;
  const size = p.kitchen.size;

  const steps = [];

  // Declutter (always)
  steps.push({
    id:"declutter",
    title:`Rapid Declutter (${p.mode === "express" ? "Sprint" : p.mode === "deep" ? "Thorough" : "Focused"})`,
    offset: s.declutter,
    duration: scaledMinutes(size, p.guestsComing ? 4 : 6, p.mode, p.cleanlinessScore) + "m",
    kind:"prep",
    instructions:[
      "Clear mail/toys; corral items into a catch-all bin.",
      "Scrape plates; stack near sink/dishwasher.",
      p.guestsComing ? "Stash visible clutter in a temporary bin to sort later." : null,
    ].filter(Boolean),
    signals:[{ type:"ui/progress", value:0.1 }]
  });

  if (p.focusAreas.dishes) {
    steps.push({
      id:"dishes",
      title: p.kitchen.hasDishwasher ? "Load Dishwasher / Hand-Wash Bigs" : "Speed Hand-Wash Dishes",
      offset: s.dishes,
      duration: scaledMinutes(size, 6, p.mode, p.cleanlinessScore) + "m",
      kind:"wash",
      instructions: p.kitchen.hasDishwasher ? [
        "Quick pre-rinse; load by zones (plates, bowls, utensils).",
        "Start cycle; soak oversized pots with hot soapy water."
      ] : [
        "Fill one basin hot soapy; one rinse.",
        "Wash biggest items first, then plates/utensils."
      ],
      reminders:[{ kind:"timer", label:"Soak Pots", minutes: clamp(Math.round(5*modeMultiplier(p.mode)), 3, 7) }]
    });
  }

  if (p.focusAreas.hotspots) {
    steps.push({
      id:"hotspots",
      title:"High-Touch Wipe (Handles, Switches, Pulls)",
      offset: s.hotspots,
      duration: scaledMinutes(size, 4, p.mode, p.cleanlinessScore) + "m",
      kind:"wipe",
      instructions:[
        "Light switches, fridge/dishwasher handles, microwave keypad.",
        "Use fresh cloth; quick buff for stainless."
      ],
      signals:[{ type:"ui/progress", value:0.3 }]
    });
  }

  if (p.focusAreas.counters) {
    steps.push({
      id:"counters",
      title:"Counters: Spray → Dwell → Wipe → Buff",
      offset: s.counters,
      duration: scaledMinutes(size, 5, p.mode, p.cleanlinessScore) + "m",
      kind:"sanitize",
      instructions:[
        "Spray all surfaces lightly; let dwell 30–60s.",
        "Wipe in S-pattern; dry buff to avoid streaks."
      ],
      signals:[{ type:"ui/progress", value:0.5 }]
    });
  }

  if (p.focusAreas.microwave) {
    steps.push({
      id:"microwave",
      title:"Microwave Quick Steam",
      offset: s.microwave,
      duration: "3m",
      kind:"detail",
      instructions:[
        "Microwave a bowl of water 2–3m; wipe walls/turntable.",
      ],
      reminders:[{ kind:"timer", label:"Steam", minutes:3 }]
    });
  }

  if (p.focusAreas.sink) {
    steps.push({
      id:"sink",
      title:"Shine Sink & Faucet",
      offset: s.sink,
      duration: scaledMinutes(size, 3, p.mode, p.cleanlinessScore) + "m",
      kind:"detail",
      instructions:[
        "Scrub with non-scratch pad, rinse, dry.",
        "Polish faucet; wipe basin edges."
      ],
      signals:[{ type:"ui/progress", value:0.7 }]
    });
  }

  if (p.focusAreas.spotSweep) {
    steps.push({
      id:"spot-sweep",
      title:"Spot Sweep/Vac (Crumbs & High-Traffic)",
      offset: s.spotSweep,
      duration: scaledMinutes(size, 4, p.mode, p.cleanlinessScore) + "m",
      kind:"floor",
      instructions:["Under bar, stove front, sink zone; quick edge pass."],
    });
  }

  if (p.focusAreas.trash) {
    steps.push({
      id:"trash",
      title:"Trash Out / New Liner",
      offset: s.trash,
      duration:"2m",
      kind:"reset",
      instructions:["Tie bag, take out; new liner in."],
    });
  }

  // Guests polish micro-step
  if (p.guestsComing && p.preferences.fragranceFree !== true) {
    steps.push({
      id:"ambience",
      title:"Ambience Touch",
      offset:"+29m",
      duration:"1m",
      kind:"finish",
      instructions:["Light a candle or run diffuser briefly, or open window 5m."],
    });
  }

  steps.push({
    id:"reset",
    title:"Reset & Final Scan",
    offset: s.reset,
    duration:"1m",
    kind:"reset",
    instructions:[
      "Hang towel neatly; put cloths in laundry bin.",
      "Lights off. Done!"
    ],
    signals:[{ type:"ui/progress", value:1 }]
  });

  return steps;
}

/* -------------------------------- Timers ------------------------------------ */
function timersFor(params){
  const p = { ...DEFAULTS, ...params };
  const t = [];
  if (p.focusAreas.dishes) t.push({ id:"pots.soak", label:"Pots Soak", minutes: clamp(Math.round(5*modeMultiplier(p.mode)), 3, 7) });
  if (p.focusAreas.microwave) t.push({ id:"mw.steam", label:"Microwave Steam", minutes:3 });
  return t;
}

/* ---------------------------- Schedule Hints -------------------------------- */
function scheduleHintsFor(params){
  const p = { ...DEFAULTS, ...params };
  const hints = [
    { kind:"appliance", name:"vacuum", window:"5m", exclusive:false },
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
export function createQuickCleanKitchenPlan(params = {}){
  const p = { ...DEFAULTS, ...params };
  const planId = id(["cleanplan", TEMPLATE_ID, p.kitchen.size, p.mode, p.guestsComing ? "guests" : "everyday"]);

  const plan = {
    id: planId,
    templateId: TEMPLATE_ID,
    "x-domain": DOMAIN,
    "x-version": VERSION,
    title:
      p.mode === "express" ? "Quick Clean — Kitchen (≈20 min)" :
      p.mode === "deep" ? "Quick Clean — Kitchen (≈45 min)" :
      "Quick Clean — Kitchen (≈30 min)",
    description: "Fast reset with adaptive timing: declutter, dishes, hotspots, counters, microwave, sink, floor, trash.",
    tags: ["cleaning","kitchen","quick", p.mode, "eco"],

    params: p,
    resources: {
      equipment: [
        "Microfiber cloths", "Non-scratch pad", "Spray cleaner",
        p.kitchen.hasDishwasher && "Dishwasher", "Broom/Vac",
      ].filter(Boolean),
    },

    inventory: buildInventory(p),
    preflightChecks: buildPreflightChecks(p), // → orchestration “ensure supplies” / add-to-list
    steps: stepsFor(p),
    timers: timersFor(p),
    scheduleHints: scheduleHintsFor(p),
    safety: { ppe: [], ventilation: true },

    meta: {
      savable: true,
      favoriteable: true,
      authoring: { canFork: true, forkLabel: "Save your quick kitchen reset" },
      share: { portable: true },
      ui: {
        // HUD hints for a polished feel (breadcrumbs/chips)
        chips: [p.mode, p.kitchen.size, p.preferences.ecoMode ? "eco" : "std"].filter(Boolean),
      }
    },

    // Lightweight “actions” the runtime can surface as buttons (optional)
    actions: [
      { id:"start-all-timers", label:"Start Session Timers", kind:"session", payload:{ start: true } },
      { id:"open-checklist", label:"Open Checklist", kind:"ui", payload:{ section:"kitchen" } },
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

    // Small helper for Save/Favorite flows
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

    // Create a new plan with patched params (handy for “Save as…” UI)
    withParams(patch = {}){
      return createQuickCleanKitchenPlan({ ...this.params, ...patch });
    }
  };

  // Notify orchestration (draft checklist, reminders, etc.)
  try {
    const bus = (typeof window !== "undefined" && window.__suka_eventBus__) || null;
    bus?.emit?.("workplan.created", { domain: DOMAIN, templateId: TEMPLATE_ID, id: plan.id, params: p });
  } catch {}

  return plan;
}

/* -------------------------- Template Override Hook -------------------------- */
export async function getQuickCleanKitchenPlan(params = {}){
  try {
    const T = await import(/* @vite-ignore */ "@/libraries/CleanPlanTemplates");
    const api = T?.default ?? T;
    if (api?.get) {
      const external = await api.get(TEMPLATE_ID, params);
      if (external) return external;
    }
  } catch { /* optional */ }
  return createQuickCleanKitchenPlan(params);
}

/* --------------------------------- Export ----------------------------------- */
export default {
  id: TEMPLATE_ID,
  domain: DOMAIN,
  version: VERSION,
  defaults: DEFAULTS,
  create: createQuickCleanKitchenPlan,
  get: getQuickCleanKitchenPlan,
};
