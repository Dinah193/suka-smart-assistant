// src/plans/cooking/proofingBread.plan.js
/* eslint-disable no-console */
/**
 * proofingBread.plan.js — Dynamic plan factory for same-day or overnight bread proofing
 *
 * Goals:
 * - Parameterized plan users can adapt & save as their own favorite (cloud/local)
 * - Emits namespaced events used by your orchestrators (no bare "progress")
 * - Inventory-aware (includes fresh-ground whole grain flour option)
 * - Schedules pre-proof + proof + bake with offsets so PrepSessionOrchestrator can timebox
 * - Portable serialization for SavePlanButton / FavoritePicker flows
 *
 * Contract-ish shape (aligned with workplan/cookplan conventions):
 * {
 *   id, templateId, x-domain, x-version, title, description, tags[],
 *   params{}, resources{}, inventory{}, steps[], timers[], scheduleHints[], safety{},
 *   meta{ savable, favoriteable, authoring }, toPortable(), toGroceryList()
 * }
 */

const VERSION = "1.2.0";
const DOMAIN = "cooking";
const TEMPLATE_ID = "proofing-bread";

const DEFAULTS = {
  loaves: 2,                  // number of loaves
  flourType: "bread",         // bread | ap | fresh-whole-wheat | fresh-whole-spelt | blend
  hydrationPct: 70,           // baker's %
  preferment: "none",         // none | poolish | levain
  yeastType: "instant",       // instant | active-dry | sourdough
  overnight: false,           // true = retard in fridge
  saltPct: 2,                 // baker's %
  wholeGrainPct: 0,           // 0..100 applies if flourType === blend
  loafSizeGrams: 750,         // target loaf weight
  bakeVessel: "dutch-oven",   // dutch-oven | baking-steel | loaf-pan
  useSteam: true,             // add steam if not dutch-oven
  sabbathGuard: false,
};

function grams(n) { return Math.round(Number(n) || 0); }
function pct(n) { const v = Number(n); return Number.isFinite(v) ? v : 0; }
function clamp(n, a, b){ return Math.max(a, Math.min(b, n)); }
function id(parts){ return parts.filter(Boolean).join(":"); }

/** Compute formula by baker's % */
function computeFormula(params) {
  const p = { ...DEFAULTS, ...params };
  const totalDough = p.loaves * p.loafSizeGrams;
  const salt = totalDough * (pct(p.saltPct) / 100);
  // flour + water + salt (+ yeast is tiny) ≈ total; back-solve flour mass
  // flourMass * (1 + hydration + salt%) ≈ totalDough
  const flourMass = totalDough / (1 + (pct(p.hydrationPct) / 100) + (pct(p.saltPct) / 100));
  const water = flourMass * (pct(p.hydrationPct) / 100);

  const yeastGrams = p.yeastType === "sourdough"
    ? 0
    : (p.overnight ? 0.5 : 1.5) * (p.yeastType === "active-dry" ? 1.2 : 1.0); // heuristics

  const prefermentFlourPct = (p.preferment === "poolish" || p.preferment === "levain") ? 20 : 0;
  const prefermentFlour = flourMass * (prefermentFlourPct / 100);
  const prefermentWater = prefermentFlour; // 100% hydration preferment
  const finalFlour = flourMass - prefermentFlour;
  const finalWater = water - prefermentWater;

  // flour breakdown by type (includes fresh-ground options)
  let flourBreakdown = [];
  if (p.flourType === "fresh-whole-wheat" || p.flourType === "fresh-whole-spelt") {
    flourBreakdown = [{ name: p.flourType, grams: grams(flourMass) }];
  } else if (p.flourType === "blend") {
    const whole = clamp(p.wholeGrainPct, 0, 100) / 100;
    flourBreakdown = [
      { name: "fresh-whole-wheat", grams: grams(flourMass * whole) },
      { name: "bread", grams: grams(flourMass * (1 - whole)) },
    ];
  } else {
    flourBreakdown = [{ name: p.flourType, grams: grams(flourMass) }];
  }

  return {
    totals: { flour: grams(flourMass), water: grams(water), salt: grams(salt), yeast: grams(yeastGrams) },
    preferment: prefermentFlourPct ? {
      kind: p.preferment,
      flour: grams(prefermentFlour),
      water: grams(prefermentWater),
      inoculation: p.yeastType === "sourdough" ? 20 : 0, // %
    } : null,
    finalMix: {
      flour: grams(finalFlour),
      water: grams(finalWater),
      salt: grams(salt),
      yeast: grams(yeastGrams),
    },
    flourBreakdown,
  };
}

/** Build inventory list with SKUs/tags when available */
function buildInventory(params) {
  const f = computeFormula(params);
  const items = [];

  // Flour lines
  for (const part of f.flourBreakdown) {
    const name = part.name === "bread" ? "Bread Flour"
      : part.name === "ap" ? "All-Purpose Flour"
      : part.name === "fresh-whole-wheat" ? "Fresh-Ground Whole Wheat Flour"
      : part.name === "fresh-whole-spelt" ? "Fresh-Ground Whole Spelt Flour"
      : "Flour";
    items.push({
      id: `flour:${part.name}`,
      name,
      qty: part.grams / 1000, unit: "kg",
      tags: ["baking", "flour", part.name],
      aisle: "Baking",
      notes: part.name.startsWith("fresh-") ? "Grind just before mixing for best flavor." : null,
    });
  }

  // Water/Salt/Yeast
  items.push({ id: "water", name: "Water", qty: f.totals.water, unit: "g", tags: ["baking"], aisle: "Pantry" });
  items.push({ id: "salt", name: "Fine Sea Salt", qty: f.totals.salt, unit: "g", tags: ["baking"], aisle: "Spices" });

  if (params.yeastType !== "sourdough") {
    items.push({
      id: `yeast:${params.yeastType}`,
      name: params.yeastType === "instant" ? "Instant Yeast" : "Active Dry Yeast",
      qty: f.totals.yeast, unit: "g", tags: ["baking", "yeast"], aisle: "Baking",
    });
  } else {
    items.push({
      id: "starter",
      name: "Sourdough Starter (active)",
      qty: 50, unit: "g",
      tags: ["baking", "starter"], aisle: "Fridge",
      notes: "Feed 6–12h prior, use at peak.",
    });
  }

  return items;
}

/** Build step list w/ offsets for the orchestrator */
function buildSteps(params) {
  const p = { ...DEFAULTS, ...params };
  const steps = [];
  const timeline = {
    // negative offsets mean "before bake window starts"
    // orchestrator will map these against selected start/end
    bulk: p.overnight ? "-12h" : "-2h",
    benchRest: p.overnight ? "-1h" : "-45m",
    proof: p.overnight ? "-30m" : "-75m",
    preheat: p.bakeVessel === "dutch-oven" ? "-45m" : "-30m",
    bake: "-0m",
  };

  const flourLine = computeFormula(p);

  // Mix
  steps.push({
    id: "mix.autolyse",
    title: "Mix & Autolyse",
    offset: p.overnight ? "-14h" : "-2h30m",
    duration: p.overnight ? "30m" : "30m",
    kind: "prep",
    instructions: [
      `Combine ${flourLine.finalMix.flour}g flour + ${flourLine.finalMix.water}g water until shaggy.`,
      "Rest covered (autolyse).",
    ],
    reminders: [{ kind: "timer", label: "Autolyse", minutes: 30 }],
  });

  // Add salt/yeast/starter
  steps.push({
    id: "mix.additives",
    title: "Add Salt & Yeast/Starter",
    offset: p.overnight ? "-13h30m" : "-2h",
    duration: "10m",
    kind: "prep",
    instructions: [
      `Add ${flourLine.finalMix.salt}g salt${p.yeastType !== "sourdough" ? ` + ${flourLine.finalMix.yeast}g ${p.yeastType} yeast` : ""}.`,
      p.yeastType === "sourdough" ? "Fold in active starter" : "Knead until moderately developed.",
    ],
  });

  // Bulk fermentation
  steps.push({
    id: "bulk.ferment",
    title: "Bulk Fermentation + Stretch & Folds",
    offset: timeline.bulk,
    duration: p.overnight ? "12h" : "90m",
    kind: "ferment",
    instructions: [
      p.overnight ? "Ferment covered at 4°C (refrigerator) overnight." :
        "Ferment at room temperature; perform 3–4 stretch & folds every 30 minutes.",
    ],
    reminders: [
      { kind: "timer", label: "S&F #1", minutes: 30, disabled: p.overnight },
      { kind: "timer", label: "S&F #2", minutes: 60, disabled: p.overnight },
      { kind: "timer", label: "S&F #3", minutes: 90, disabled: p.overnight },
    ],
    signals: [{ type: "ui/progress", value: 0.5 }],
  });

  // Pre-shape + bench rest
  steps.push({
    id: "preshape",
    title: "Pre-shape & Bench Rest",
    offset: timeline.benchRest,
    duration: p.overnight ? "45m" : "20m",
    kind: "shape",
    instructions: [
      "Turn dough out, divide into even pieces.",
      "Pre-shape rounds, rest seam-side down on lightly floured surface.",
    ],
    reminders: [{ kind: "timer", label: "Bench Rest", minutes: p.overnight ? 45 : 20 }],
  });

  // Shape & proof
  steps.push({
    id: "shape.proof",
    title: "Final Shape & Proof",
    offset: timeline.proof,
    duration: p.overnight ? "30m" : "60m",
    kind: "proof",
    instructions: [
      "Shape tight boules/batards. Transfer seam-side up to floured bannetons.",
      p.overnight ? "Proof at room temp while the oven preheats." : "Proof until puffy and passes poke test.",
    ],
    reminders: [{ kind: "timer", label: "Proof", minutes: p.overnight ? 30 : 60 }],
  });

  // Preheat
  steps.push({
    id: "oven.preheat",
    title: "Preheat Oven",
    offset: timeline.preheat,
    duration: p.bakeVessel === "dutch-oven" ? "45m" : "30m",
    kind: "preheat",
    instructions: [
      p.bakeVessel === "dutch-oven"
        ? "Preheat oven to 475°F (246°C) with Dutch ovens inside."
        : "Preheat oven to 475°F (246°C). Place a steam tray if using.",
    ],
    reminders: [{ kind: "timer", label: "Preheat", minutes: p.bakeVessel === "dutch-oven" ? 45 : 30 }],
    schedule: [{ kind: "preheat", tempF: 475 }],
  });

  // Bake
  steps.push({
    id: "bake",
    title: "Bake",
    offset: timeline.bake,
    duration: "45m",
    kind: "bake",
    instructions: [
      "Score loaves.",
      p.bakeVessel === "dutch-oven"
        ? "Bake covered 20m, uncover and bake 20–25m more until deep brown."
        : p.useSteam
          ? "Steam 15m at start, then vent; bake 25–30m total until deep brown."
          : "Bake 30–35m until deep brown.",
      "Cool at least 1 hour before slicing.",
    ],
    reminders: [
      { kind: "timer", label: "Bake — covered/steam", minutes: 20 },
      { kind: "timer", label: "Bake — finish", minutes: 25 },
    ],
    safety: [{ type: "ppe", items: ["oven-mitts"] }],
  });

  return steps;
}

/** Build timers panel entries for SessionHUD / MultiTimer */
function buildTimers(params) {
  const p = { ...DEFAULTS, ...params };
  const timers = [
    { id: "autolyse", label: "Autolyse", minutes: 30 },
    { id: "preheat", label: "Preheat", minutes: p.bakeVessel === "dutch-oven" ? 45 : 30 },
    { id: "proof", label: "Proof", minutes: p.overnight ? 30 : 60 },
    { id: "bake.covered", label: "Bake — covered/steam", minutes: 20 },
    { id: "bake.finish", label: "Bake — finish", minutes: 25 },
  ];
  return timers;
}

/** Schedule hints for calendar sync */
function buildScheduleHints(params) {
  const p = { ...DEFAULTS, ...params };
  return [
    { kind: "withhold", reason: "dough-resting", duration: p.overnight ? "12h" : "2h" },
    { kind: "appliance", name: "oven", window: "45m", exclusive: true },
    { kind: "biohazard", rule: "raw-dough-handwash" },
  ];
}

// ---------------------------- public factory ---------------------------------
export function createProofingBreadPlan(params = {}) {
  const p = { ...DEFAULTS, ...params };
  const formula = computeFormula(p);
  const planId = id(["cookplan", TEMPLATE_ID, `${p.loaves}x${p.loafSizeGrams}`, p.overnight ? "overnight" : "same-day"]);

  const plan = {
    id: planId,
    templateId: TEMPLATE_ID,
    "x-domain": DOMAIN,
    "x-version": VERSION,
    title: p.overnight ? "Overnight Bread: Proof & Bake" : "Same-Day Bread: Proof & Bake",
    description:
      "Guided proofing and bake workflow with timers, substitutions, and inventory hooks. Optimized for Dutch oven or steam baking.",
    tags: ["baking", "bread", "proofing", "whole-grain", p.flourType],
    params: p,
    resources: {
      equipment: [
        p.bakeVessel === "dutch-oven" ? "Dutch Ovens (preheated)" :
          p.bakeVessel === "baking-steel" ? "Baking Steel + Steam Tray" : "Loaf Pans",
        "Bannetons or lined bowls", "Lame/Sharp blade", "Scale", "Mixing bowl", "Bench scraper",
      ],
      references: [
        { label: "Crumb target", notes: "Aim for deep brown crust and 208–210°F internal temp." },
      ],
    },
    inventory: buildInventory(p),                   // -> InventoryMonitor signals
    steps: buildSteps(p),                           // -> PrepSessionOrchestrator
    timers: buildTimers(p),                         // -> SessionHUD/MultiTimer
    scheduleHints: buildScheduleHints(p),           // -> calendarSync
    safety: { ppe: ["oven-mitts"], hygiene: ["handwash-after-raw-dough"] },
    meta: {
      savable: true,
      favoriteable: true,
      authoring: { canFork: true, forkLabel: "Save your own bread plan" },
      share: { portable: true },
    },

    /** Generate pantry/grocery lines for listBuilder */
    toGroceryList() {
      return this.inventory.map(it => ({
        id: it.id, name: it.name, qty: it.qty, unit: it.unit, aisle: it.aisle, tags: it.tags,
      }));
    },

    /** Create a portable payload for SavePlanButton / FavoriteImportButton */
    toPortable() {
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
    },
  };

  // Emit a creation event so UI can prefill Save modal/NBA
  try {
    // lazy access to eventBus if it was already mounted globally by the app
    const bus = (typeof window !== "undefined" && window.__suka_eventBus__) || null;
    bus?.emit?.("workplan.created", { domain: DOMAIN, templateId: TEMPLATE_ID, id: plan.id, params: p });
  } catch {}

  return plan;
}

// ----------------------------- template strategy ------------------------------
/**
 * Prefer external templates library if present, else fall back to in-file factory.
 * This allows you to add/override plan variations without touching this file.
 */
export async function getProofingBreadPlan(params = {}) {
  try {
    const T = await import(/* @vite-ignore */ "@/libraries/CookPlanTemplates");
    const api = T?.default ?? T;
    if (api?.get) {
      const external = await api.get(TEMPLATE_ID, params);
      if (external) return external;
    }
  } catch { /* no external library yet */ }
  return createProofingBreadPlan(params);
}

// ----------------------------- default export --------------------------------
export default {
  id: TEMPLATE_ID,
  domain: DOMAIN,
  version: VERSION,
  defaults: DEFAULTS,
  create: createProofingBreadPlan,
  get: getProofingBreadPlan,
};
