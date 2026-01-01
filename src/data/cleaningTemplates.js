// @/data/cleaningTemplates.js
// Central place for appliance routines + bug-shield fragrance packs
// + Behavior-first routine templates (Standard / Deep w/ declutter & morning outflow).

/* ----------------------------------------------------------------------------
   Tags & helpers
---------------------------------------------------------------------------- */
export const CLEANING_TAGS = {
  ZONES: [
    "Kitchen", "Bathrooms", "Bedrooms", "Living Areas", "Laundry/Utility",
    "Entry/Mudroom", "Windows/Fixtures", "Outdoor"
  ],
  CADENCE: ["daily","weekly","biweekly","monthly","quarterly","biannual","annual","seasonal"],
  FOCUS: ["declutter","sanitize","detail","reset","organize","outflow","appliance","bug-shield"]
};

const CAD = (c) => c; // sugar
const idFrom = (prefix, i, extra = "") => `${prefix}${extra ? `-${extra}` : ""}-${i}`;

/* ----------------------------------------------------------------------------
   Core appliance routines (safe, simple)
---------------------------------------------------------------------------- */
const APPLIANCE_PACKS = [
  {
    id: "appliance:fridge-deep",
    title: "Fridge | Monthly Deep Clean",
    tasks: [
      { name: "Fridge: remove contents, toss expired, wipe shelves (vinegar/water 1:1)", cadence: CAD("monthly"), zone: "Kitchen", requires: ["microfiber","white-vinegar"], tags:["appliance:fridge","appliance"] },
      { name: "Fridge: gasket wipe & inspect (mild soap)", cadence: CAD("monthly"), zone: "Kitchen", requires: ["mild-soap"], tags:["appliance:fridge","appliance"] },
      { name: "Fridge: drip pan & vent dust", cadence: CAD("quarterly"), zone: "Kitchen", requires: ["brush","vacuum"], tags:["appliance:fridge","appliance"] },
    ]
  },
  {
    id: "appliance:oven-cycle",
    title: "Oven | Quarterly Refresh",
    tasks: [
      { name: "Oven: racks soak (hot water + baking soda)", cadence: CAD("quarterly"), zone: "Kitchen", requires: ["baking-soda"], tags:["appliance:oven","appliance"] },
      { name: "Oven: interior wipe (paste baking soda + water, then vinegar spritz)", cadence: CAD("quarterly"), zone: "Kitchen", requires: ["baking-soda","white-vinegar"], tags:["appliance:oven","appliance"] },
      { name: "Stovetop: degrease & polish controls", cadence: CAD("monthly"), zone: "Kitchen", requires: ["degreaser"], tags:["appliance:stove","appliance"] },
    ]
  },
  {
    id: "appliance:dishwasher-care",
    title: "Dishwasher | Monthly Care",
    tasks: [
      { name: "Dishwasher: clean filter & spray arms", cadence: CAD("monthly"), zone: "Kitchen", requires:["brush"], tags:["appliance:dishwasher","appliance"] },
      { name: "Dishwasher: run hot cycle with vinegar (top rack)", cadence: CAD("monthly"), zone: "Kitchen", requires:["white-vinegar"], tags:["appliance:dishwasher","appliance"] },
    ]
  },
  {
    id: "appliance:laundry-fresh",
    title: "Washer/Dryer | Lint & Drum Care",
    tasks: [
      { name: "Dryer: lint trap & exterior vent vacuum", cadence: CAD("weekly"), zone: "Laundry/Utility", requires:["vacuum"], tags:["appliance:dryer","appliance"] },
      { name: "Washer: drum clean (hot cycle + white vinegar)", cadence: CAD("monthly"), zone: "Laundry/Utility", requires:["white-vinegar"], tags:["appliance:washer","appliance"] },
      { name: "Washer: gasket & detergent drawer wipe", cadence: CAD("monthly"), zone: "Laundry/Utility", requires:["mild-soap"], tags:["appliance:washer","appliance"] },
    ]
  },
  {
    id: "appliance:filters",
    title: "Filters | Returns & Purifiers",
    tasks: [
      { name: "HVAC return: vacuum grille & replace/clean filter", cadence: CAD("monthly"), zone: "Living Areas", requires:["vacuum","filter"], tags:["appliance:hvac","appliance"] },
      { name: "Air purifier/humidifier: descale & sanitize reservoir", cadence: CAD("monthly"), zone: "Living Areas", requires:["descaler"], tags:["appliance:air","appliance"] },
    ]
  },
  {
    id: "appliance:smallwares",
    title: "Small Appliances | Quick Cycle",
    tasks: [
      { name: "Microwave: steam clean (bowl water + lemon, 3–5 min)", cadence: CAD("weekly"), zone: "Kitchen", requires:["lemon"], tags:["appliance:microwave","appliance"] },
      { name: "Coffee maker/kettle: descale (per manufacturer)", cadence: CAD("monthly"), zone: "Kitchen", requires:["descaler"], tags:["appliance:coffee","appliance"] },
      { name: "Garbage disposal: citrus ice cube deodorize", cadence: CAD("weekly"), zone: "Kitchen", requires:["citrus-peel","ice"], tags:["appliance:disposal","appliance"] },
    ]
  }
];

/* ----------------------------------------------------------------------------
   Bug-shield fragrance routines (pet/child aware; mild & surface-safe)
---------------------------------------------------------------------------- */
const BUG_PACKS = [
  {
    id: "bug:ants",
    title: "Bug Shield | Ants",
    tasks: [
      { name: "Perimeter wipe (baseboards/counter edges) with vinegar/water 1:1", cadence: "weekly", zone:"Kitchen", requires:["white-vinegar"], tags:["bug:ants","bug-shield","fragrance:vinegar"] },
      { name: "Entry points: peppermint water spritz (avoid on bare wood; test first)", cadence: "weekly", zone:"Kitchen", requires:["peppermint"], tags:["bug:ants","bug-shield","fragrance:peppermint"] },
    ],
    constraints:{ fragranceFreeOk:true } // vinegar ok if fragrance-free
  },
  {
    id: "bug:roaches",
    title: "Bug Shield | Roaches",
    tasks: [
      { name: "Degrease under/behind stove & fridge rails", cadence: "weekly", zone:"Kitchen", requires:["degreaser"], tags:["bug:roaches","bug-shield"] },
      { name: "Clove + lemon wipe on cabinet undersides (light, test first)", cadence: "weekly", zone:"Kitchen", requires:["clove","lemon"], tags:["bug:roaches","bug-shield","fragrance:clove","fragrance:lemon"] },
    ]
  },
  {
    id: "bug:pantry",
    title: "Bug Shield | Pantry Moths/Beetles",
    tasks: [
      { name: "Pantry: decant grains to sealed jars; bay leaves in bins", cadence:"monthly", zone:"Kitchen", requires:["bay-leaves","jars"], tags:["bug:pantry","bug-shield","fragrance:bay"] },
      { name: "Shelf wipe (vinegar/water) & inspect for webbing", cadence:"monthly", zone:"Kitchen", requires:["white-vinegar"], tags:["bug:pantry","bug-shield"] },
    ],
    constraints:{ fragranceFreeOk:true }
  },
  {
    id: "bug:flies",
    title: "Bug Shield | Flies",
    tasks: [
      { name: "Drain maintenance: weekly baking soda + vinegar flush", cadence:"weekly", zone:"Kitchen", requires:["baking-soda","white-vinegar"], tags:["bug:flies","bug-shield"] },
      { name: "Citrus peel trap or apple-cider-vinegar cup away from prep area", cadence:"weekly", zone:"Kitchen", requires:["citrus","acv"], tags:["bug:flies","bug-shield","fragrance:citrus"] },
    ]
  },
  {
    id: "bug:closet-moths",
    title: "Bug Shield | Closet (Moths/Silverfish)",
    tasks: [
      { name: "Cedar blocks refresh & rotate; vacuum closet floor edges", cadence:"monthly", zone:"Bedrooms", requires:["cedar-blocks","vacuum"], tags:["bug:moths","bug-shield","fragrance:cedar"] },
      { name: "Lavender satchets replace", cadence:"quarterly", zone:"Bedrooms", requires:["lavender"], tags:["bug:moths","bug-shield","fragrance:lavender"] },
    ]
  },
];

/* ----------------------------------------------------------------------------
   Packs API
---------------------------------------------------------------------------- */
export function getPacks({ targetBugs = [], includeAppliances = true, fragranceFree = false, avoidLoud = false } = {}) {
  const packs = [];
  if (includeAppliances) packs.push(...APPLIANCE_PACKS);
  if (targetBugs?.length) {
    const wanted = new Set(targetBugs.map(String));
    // allow e.g. ["ants","pantry"] or full ids like "bug:ants"
    packs.push(...BUG_PACKS.filter(p => {
      const key = p.id.includes(":") ? p.id.split(":")[1] : p.id;
      return wanted.has(key) || wanted.has(p.id);
    }));
  }
  // Apply simple constraints
  return packs
    .filter(p => !fragranceFree || p.constraints?.fragranceFreeOk || p.id.startsWith("appliance:"))
    .map(p => ({
      ...p,
      tasks: p.tasks.filter(t => !(avoidLoud && /vacuum/i.test(t.name)))
    }));
}

/** Helper to flatten selected packs to tasks-by-zone */
export function materializePacks(packs = []) {
  const tasksByZone = {};
  for (const pack of packs) {
    for (const t of pack.tasks) {
      const z = t.zone || "General";
      (tasksByZone[z] ||= []).push({ ...t });
    }
  }
  return tasksByZone;
}

/* ----------------------------------------------------------------------------
   Behavior-first Routine Templates (Standard / Deep)
   - Standard: weekly resets by zone
   - Deep: declutter-first + detail + morning outflow playbooks
---------------------------------------------------------------------------- */

// Morning outflow playbooks (room-by-room) — concise version for this file.
// (Full designer lives in organizingStrategies.js, but we mirror key tasks here
// so this module is self-sufficient.)
const ROOM_OUTFLOW = {
  "Entry/Mudroom": [
    "Shake or vacuum entry mat",
    "Return keys to hook/bowl; phones to charger shelf",
    "Sort mail: recycle junk; action tray holds bills",
    "Stage donate/return bins for car if planned"
  ],
  "Kitchen": [
    "Unload dishwasher while coffee brews",
    "Prep quick breakfast; load tools immediately",
    "Wipe counters & table; quick floor sweep",
    "Set out thaw box or slow-cooker base for dinner"
  ],
  "Bathrooms": [
    "Use vanity caddy; return items after use",
    "Squeegee glass; quick wipe sink & faucet",
    "Swap towel if beyond reuse threshold",
    "Empty tiny trash to main bin if near full"
  ],
  "Bedrooms": [
    "Make the bed immediately on wake",
    "Hamper scan: clothes off floors/chair",
    "Reset nightstand; charge devices at one station",
    "Stage outfit; pack any special items"
  ],
  "Laundry/Utility": [
    "Move started load to dryer/fold table",
    "Set timer to switch cycles",
    "Check donate/return bin; stage if ready"
  ],
  "Living Areas": [
    "Sweep surfaces into labeled baskets then return",
    "Corral remotes/chargers in one tray",
    "Quick vacuum high-traffic pathway",
    "Stage tonight’s wind-down basket"
  ],
};

const DECLUTTER_KIT = [
  { id: "bin-keep",     title: "Keep (store here)",             type: "bin" },
  { id: "bin-relocate", title: "Relocate (move to right zone)", type: "bin" },
  { id: "bin-donate",   title: "Donate",                        type: "bin" },
  { id: "bin-recycle",  title: "Recycle",                       type: "bin" },
  { id: "bin-trash",    title: "Trash",                         type: "bin" }
];

function resolveCadence(defaultCadence, longCadence) {
  if (!longCadence) return defaultCadence;
  if (typeof longCadence === "string" && longCadence !== "custom") return longCadence;
  return defaultCadence; // placeholder for future per-zone overrides
}

function tagify(t) {
  const base = new Set([t.zone, ...(t.focus ?? [])]);
  (t.tags ?? []).forEach(x => base.add(x));
  return [...base];
}

/**
 * getRoutineTemplates()
 * @param {object} opts
 *  - routineType: "Standard" | "Deep"
 *  - longCadence: string | null ("monthly" | "quarterly" | "biannual" | "annual" | "custom")
 *  - profile: optional user/household profile (reserved)
 *  - deepFocus: optional object { landingZones, morningTasks, ... } (merges in)
 *  - includePacks: string[] of pack ids to merge into tasks (e.g., ["appliance:fridge-deep","bug:ants"])
 *  - pets, familySize, cleaningPrefs: optional nudges
 * @returns Task[]
 */
export function getRoutineTemplates(opts = {}) {
  const {
    routineType = "Standard",
    longCadence = null,
    profile = null,
    deepFocus = null,
    includePacks = [],
    pets = 0,
    familySize = 2,
    cleaningPrefs = {},
  } = opts;

  // --- STANDARD: weekly reset tasks by common zones
  const STANDARD = [
    { id: "std-kitchen",  zone: "Kitchen",        title: "Surfaces, dishes, quick floor", cadence: "weekly", focus: ["reset","sanitize"] },
    { id: "std-baths",    zone: "Bathrooms",      title: "Toilet, sink, mirror, quick tub", cadence: "weekly", focus: ["sanitize","reset"] },
    { id: "std-beds",     zone: "Bedrooms",       title: "Reset surfaces, hamper sweep", cadence: "weekly", focus: ["reset"] },
    { id: "std-living",   zone: "Living Areas",   title: "Surfaces, quick vacuum",       cadence: "weekly", focus: ["reset"] },
    { id: "std-entry",    zone: "Entry/Mudroom",  title: "Reset drop-zone, sweep",        cadence: "weekly", focus: ["reset","organize"] },
    { id: "std-laundry",  zone: "Laundry/Utility",title: "Clear surfaces; lint bin empty", cadence: "weekly", focus: ["reset"] },
  ];

  if (pets > 0) {
    STANDARD.push({ id: "std-pet-defur", zone: "Living Areas", title: "Quick de-fur high traffic & sofa", cadence: "daily", focus:["reset"] });
  }
  if (familySize >= 4) {
    STANDARD.push({ id: "std-dishes-midday", zone:"Kitchen", title:"Mid-day dish sweep (if WFH/kids)", cadence:"daily", focus:["reset"] });
  }

  // --- DEEP: declutter-first + detail tasks + morning outflow scaffolding
  const DEEP_DETAIL = [
    // Kitchen
    { id: "deep-kitchen-declutter", zone: "Kitchen", title: "DECLUTTER counters, drawers & pantry (5-bin method)", cadence: resolveCadence("monthly", longCadence), focus: ["declutter","organize"], supplies: DECLUTTER_KIT },
    { id: "deep-kitchen-detail",    zone: "Kitchen", title: "Detail: cabinet faces, handles, backsplash grout",   cadence: resolveCadence("quarterly", longCadence), focus: ["detail","sanitize"] },
    { id: "deep-fridge-pantry",     zone: "Kitchen", title: "Purge expired; decant & label pantry",               cadence: resolveCadence("monthly", longCadence), focus: ["organize","reset"] },

    // Bathrooms
    { id: "deep-bath-declutter",    zone: "Bathrooms", title: "DECLUTTER vanities & caddies (5-bin)",             cadence: resolveCadence("monthly", longCadence), focus: ["declutter","organize"], supplies: DECLUTTER_KIT },
    { id: "deep-bath-detail",       zone: "Bathrooms", title: "Detail scrub grout/caulk; descale glass & fixtures", cadence: resolveCadence("quarterly", longCadence), focus: ["detail","sanitize"] },

    // Bedrooms
    { id: "deep-bed-closet",        zone: "Bedrooms", title: "Closet reset: seasonal rotate; donate/consign",     cadence: resolveCadence("quarterly", longCadence), focus: ["organize","declutter"], supplies: DECLUTTER_KIT },
    { id: "deep-bed-under",         zone: "Bedrooms", title: "Under-bed vacuum; storage bins audit/label",        cadence: resolveCadence("quarterly", longCadence), focus: ["detail","organize"] },

    // Living Areas
    { id: "deep-living-declutter",  zone: "Living Areas", title: "DECLUTTER surfaces, toy/media zones (5-bin)",    cadence: resolveCadence("monthly", longCadence), focus: ["declutter","organize"], supplies: DECLUTTER_KIT },
    { id: "deep-living-detail",     zone: "Living Areas", title: "Baseboards, vents, soft-furnish deep vacuum",    cadence: resolveCadence("quarterly", longCadence), focus: ["detail"] },

    // Laundry/Utility
    { id: "deep-laundry-org",       zone: "Laundry/Utility", title: "Detergent decant; lint duct clean; shelf reset", cadence: resolveCadence("quarterly", longCadence), focus: ["organize","detail"] },

    // Entry/Mudroom
    { id: "deep-entry-org",         zone: "Entry/Mudroom", title: "Landing-zone redesign: hooks, trays, labels",  cadence: resolveCadence("monthly", longCadence), focus: ["organize","reset"] },

    // Windows/Fixtures
    { id: "deep-windows",           zone: "Windows/Fixtures", title: "Windows in/out (as feasible), tracks & screens", cadence: resolveCadence("biannual", longCadence), focus: ["detail"] },

    // Outdoor
    { id: "deep-outdoor",           zone: "Outdoor", title: "Porch sweep; entry mats shake/wash; cobwebs",         cadence: resolveCadence("monthly", longCadence), focus: ["reset","detail"] },
  ];

  // Build morning outflow tasks (daily) for each common room
  const MORNING_OUTFLOW = Object.entries(ROOM_OUTFLOW).flatMap(([zone, tasks]) =>
    tasks.map((title, i) => ({
      id: idFrom("am", i, zone.replace(/\W+/g, '').toLowerCase()),
      zone,
      title,
      cadence: "daily",
      focus: ["reset","outflow"]
    }))
  );

  // Choose base set
  const base = routineType === "Deep" ? [...DEEP_DETAIL, ...MORNING_OUTFLOW] : [...STANDARD];

  // Merge in selected packs (appliances/bugs) as additional tasks; tag with focus
  const extra = [];
  if (includePacks?.length) {
    const packIndex = Object.fromEntries(
      [...APPLIANCE_PACKS, ...BUG_PACKS].map(p => [p.id, p])
    );
    includePacks.forEach(pid => {
      const p = packIndex[pid];
      if (!p) return;
      p.tasks.forEach((t, i) => {
        extra.push({
          id: idFrom("pack", i, pid.replace(/[:]/g,"-")),
          zone: t.zone || "General",
          title: t.name,
          cadence: t.cadence || "monthly",
          requires: t.requires || [],
          focus: ["reset", ...(t.tags?.includes("bug-shield") ? ["sanitize"] : []), "appliance"].filter(Boolean),
          tags: t.tags || []
        });
      });
    });
  }

  // Normalize & order
  const result = [...base, ...extra].map((t, i) => ({
    id: t.id || idFrom("task", i),
    title: t.title || t.name,
    zone: t.zone || "General",
    cadence: t.cadence || "weekly",
    focus: t.focus || [],
    supplies: t.supplies || null,
    requires: t.requires || [],
    tags: tagify({ ...t }),
    order: i + 1,
    longCadence: routineType === "Deep" ? (longCadence || t.cadence) : null
  }));

  // If a deepFocus object is present (from the EntryExitFlowDesigner), append its morningTasks
  if (routineType === "Deep" && deepFocus?.morningTasks?.length) {
    const offset = result.length;
    deepFocus.morningTasks.forEach((mt, idx) => {
      result.push({
        id: mt.id || idFrom("am", offset + idx),
        title: mt.title,
        zone: mt.zone || "Entry/Mudroom",
        cadence: mt.cadence || "daily",
        focus: mt.focus || ["reset","outflow"],
        tags: tagify({ zone: mt.zone || "Entry/Mudroom", focus: mt.focus || ["reset","outflow"] }),
        order: result.length + 1
      });
    });
  }

  return result;
}

/* ----------------------------------------------------------------------------
   Optional seed helper used by legacy callers
---------------------------------------------------------------------------- */
export function getRoutineSeed({ zone, familySize = 2, cleaningPrefs = {}, pets = 0 } = {}) {
  // Maintained for compatibility with any older imports
  const base = [];
  if (zone === "Kitchen") {
    base.push({ name: "Sanitize handles (fridge/oven/microwave)", cadence:"weekly" });
  }
  if (zone === "Laundry/Utility") {
    base.push({ name: "Sort station tidy & lint bin empty", cadence:"weekly" });
  }
  if (pets > 0) base.push({ name:"Quick de-fur (lint/vacuum)", cadence:"daily" });
  return { tasks: base };
}
