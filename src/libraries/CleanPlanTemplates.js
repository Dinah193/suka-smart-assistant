// File: C:\Users\larho\suka-smart-assistant\src\libraries\CleanPlanTemplates.js
/**
 * CleanPlanTemplates
 * -----------------------------------------------------------------------------
 * SSA: Fixed, non-AI "cleaning plan" templates library.
 *
 * Purpose
 *  - Provide a curated set of cleaning plan templates that can be:
 *      • listed/browsed
 *      • instantiated into a plan for a household/user
 *      • converted into a cleaning session blueprint (steps)
 *      • used to generate "today's cleaning" cards without AI
 *
 * Design
 *  - Templates are plain JS objects: stable IDs, predictable structure.
 *  - Includes:
 *      • daily maintenance templates
 *      • weekly zone rotation templates
 *      • deep-clean templates
 *      • move-in/out templates
 *      • "Sabbath-aware" options (quiet hours / light tasks)
 *
 * Integration assumptions (soft)
 *  - You likely have:
 *      • eventBus: "@/services/events/eventBus"
 *      • session blueprint builder elsewhere (optional)
 *  - This module does not import them; it’s a library only.
 *
 * Template shape
 *  {
 *    id: "clean.weekly.zones.v1",
 *    name: "Weekly Zone Rotation (4-Zone)",
 *    version: 1,
 *    tags: ["weekly","zones","whole-home"],
 *    description: "...",
 *    defaults: { durationMins, intensity, sabbathAware, quietHours, ... },
 *    zones: [{ id, name, order, rooms: [] }],
 *    tasks: [
 *      {
 *        id, label, zoneId?, room?, surfaceGroup?,
 *        category: "tidy|sanitize|laundry|dishes|floors|bathroom|kitchen|dust|declutter|deep",
 *        estMins, effort: 1-5,
 *        tools: ["vacuum","mop",...],
 *        supplies: ["all-purpose spray", ...],
 *        constraints: { quietOk?: boolean, sabbathOk?: boolean, requiresMachine?: "washer|dryer|dishwasher" },
 *        instructions: ["step1","step2",...],
 *      }
 *    ],
 *    rules: { rotation?: {...}, schedule?: {...} }
 *  }
 *
 * Public API
 *  - listTemplates(filters?)
 *  - getTemplate(id)
 *  - instantiateTemplate(id, overrides) -> plan object
 *  - toSessionBlueprint(plan, opts) -> { domain:"cleaning", steps:[...] }
 */

const LIB_VERSION = 1;

/* -----------------------------------------------------------------------------
 * Helpers
 * -------------------------------------------------------------------------- */

function safeArray(x) {
  return Array.isArray(x) ? x : [];
}

function safeObject(x) {
  return x && typeof x === "object" && !Array.isArray(x) ? x : {};
}

function clamp(n, a, b) {
  const x = Number(n);
  if (!Number.isFinite(x)) return a;
  return Math.max(a, Math.min(b, x));
}

function deepMerge(base, patch) {
  const b = safeObject(base);
  const p = safeObject(patch);
  const out = { ...b };

  for (const k of Object.keys(p)) {
    const pv = p[k];
    const bv = out[k];
    if (
      pv &&
      typeof pv === "object" &&
      !Array.isArray(pv) &&
      bv &&
      typeof bv === "object" &&
      !Array.isArray(bv)
    ) {
      out[k] = deepMerge(bv, pv);
    } else {
      out[k] = pv;
    }
  }
  return out;
}

function nowMs() {
  return Date.now();
}

function genId(prefix = "cp") {
  return `${prefix}_${nowMs().toString(16)}_${Math.random()
    .toString(16)
    .slice(2)}`;
}

function pick(obj, keys) {
  const o = safeObject(obj);
  const out = {};
  for (const k of keys) if (k in o) out[k] = o[k];
  return out;
}

/* -----------------------------------------------------------------------------
 * Canonical tool/supply lexicon (non-binding)
 * -------------------------------------------------------------------------- */

const TOOL = Object.freeze({
  vacuum: "vacuum",
  broom: "broom",
  mop: "mop",
  microfiber: "microfiber cloths",
  sponge: "sponges",
  scrubBrush: "scrub brush",
  toiletBrush: "toilet brush",
  bucket: "bucket",
  duster: "duster",
  squeegee: "squeegee",
  gloves: "gloves",
  trashBags: "trash bags",
  laundryBasket: "laundry basket",
});

const SUPPLY = Object.freeze({
  allPurpose: "all-purpose cleaner",
  glass: "glass cleaner",
  disinfect: "disinfectant spray/wipes",
  degreaser: "degreaser",
  bathroom: "bathroom cleaner",
  toilet: "toilet cleaner",
  dishSoap: "dish soap",
  bakingSoda: "baking soda",
  vinegar: "vinegar",
  floorCleaner: "floor cleaner",
  polish: "wood polish",
  bleach: "bleach (optional)",
});

const CATEGORY = Object.freeze({
  tidy: "tidy",
  sanitize: "sanitize",
  dishes: "dishes",
  laundry: "laundry",
  floors: "floors",
  bathroom: "bathroom",
  kitchen: "kitchen",
  dust: "dust",
  declutter: "declutter",
  deep: "deep",
});

/* -----------------------------------------------------------------------------
 * Core Templates
 * -------------------------------------------------------------------------- */

const TEMPLATES = [
  {
    id: "clean.daily.reset.v1",
    name: "Daily Reset (20–35 min)",
    version: 1,
    tags: ["daily", "maintenance", "quick", "whole-home"],
    description:
      "A fast daily reset to keep the home from drifting: clear surfaces, dishes, trash, and high-traffic floors.",
    defaults: {
      durationMins: 30,
      intensity: "light",
      sabbathAware: true,
      quietHours: { start: "22:00", end: "07:00", deferTo: "08:00" },
      allowLoudTools: false,
      allowMachines: true,
    },
    zones: [
      { id: "zone.kitchen", name: "Kitchen", order: 1, rooms: ["kitchen"] },
      {
        id: "zone.living",
        name: "Living Areas",
        order: 2,
        rooms: ["living room", "hallway", "entry"],
      },
      { id: "zone.bath", name: "Bathrooms", order: 3, rooms: ["bathroom"] },
      { id: "zone.bed", name: "Bedrooms", order: 4, rooms: ["bedroom"] },
    ],
    tasks: [
      {
        id: "task.daily.dishes",
        label: "Dishes: load/run or wash + wipe sink",
        zoneId: "zone.kitchen",
        category: CATEGORY.dishes,
        estMins: 8,
        effort: 2,
        tools: [TOOL.sponge],
        supplies: [SUPPLY.dishSoap, SUPPLY.disinfect],
        constraints: {
          quietOk: true,
          sabbathOk: true,
          requiresMachine: "dishwasher",
        },
        instructions: [
          "Load dishwasher (or wash by hand).",
          "Wipe sink and faucet.",
          "Wipe counters (quick pass).",
        ],
      },
      {
        id: "task.daily.trash",
        label: "Trash: collect + replace liners",
        zoneId: "zone.kitchen",
        category: CATEGORY.tidy,
        estMins: 3,
        effort: 1,
        tools: [TOOL.trashBags],
        supplies: [],
        constraints: { quietOk: true, sabbathOk: true },
        instructions: ["Collect trash from main bins.", "Replace liners."],
      },
      {
        id: "task.daily.surfaces",
        label: "Surface reset: clear clutter to homes",
        zoneId: "zone.living",
        category: CATEGORY.declutter,
        estMins: 8,
        effort: 2,
        tools: [TOOL.laundryBasket],
        supplies: [],
        constraints: { quietOk: true, sabbathOk: true },
        instructions: [
          "Grab a basket for 'belongs elsewhere' items.",
          "Clear coffee table, counters, and entry surfaces.",
          "Return items to their homes (or staging bin).",
        ],
      },
      {
        id: "task.daily.floors.spot",
        label: "High-traffic floors: sweep or spot-vacuum",
        zoneId: "zone.living",
        category: CATEGORY.floors,
        estMins: 6,
        effort: 2,
        tools: [TOOL.broom, TOOL.vacuum],
        supplies: [],
        constraints: { quietOk: false, sabbathOk: true }, // vacuum is loud; broom is quiet
        instructions: [
          "Use broom for quick pass (quiet).",
          "If allowed, vacuum crumbs in high-traffic areas.",
        ],
      },
      {
        id: "task.daily.bath.quick",
        label: "Bathroom: quick wipe (sink + toilet exterior)",
        zoneId: "zone.bath",
        category: CATEGORY.bathroom,
        estMins: 5,
        effort: 2,
        tools: [TOOL.microfiber],
        supplies: [SUPPLY.bathroom, SUPPLY.disinfect],
        constraints: { quietOk: true, sabbathOk: true },
        instructions: [
          "Wipe sink and faucet.",
          "Wipe toilet exterior (lid/seat top, handle).",
          "Swap hand towel if needed.",
        ],
      },
      {
        id: "task.daily.laundry.staging",
        label: "Laundry staging: start a load or prep a basket",
        zoneId: "zone.bed",
        category: CATEGORY.laundry,
        estMins: 5,
        effort: 2,
        tools: [TOOL.laundryBasket],
        supplies: [],
        constraints: {
          quietOk: true,
          sabbathOk: true,
          requiresMachine: "washer",
        },
        instructions: [
          "Collect laundry from hampers.",
          "Start a load if time allows, or stage for tomorrow.",
        ],
      },
    ],
    rules: {
      schedule: { cadence: "daily" },
    },
  },

  {
    id: "clean.weekly.zones.4.v1",
    name: "Weekly Zone Rotation (4 Zones)",
    version: 1,
    tags: ["weekly", "zones", "whole-home", "rotation"],
    description:
      "A weekly plan that focuses on one zone per day while keeping daily reset tasks consistent.",
    defaults: {
      durationMins: 45,
      intensity: "medium",
      sabbathAware: true,
      quietHours: { start: "22:00", end: "07:00", deferTo: "08:00" },
      allowLoudTools: true,
      allowMachines: true,
      includeDailyReset: true,
    },
    zones: [
      {
        id: "zone.kitchen",
        name: "Kitchen",
        order: 1,
        rooms: ["kitchen", "pantry"],
      },
      { id: "zone.bath", name: "Bathrooms", order: 2, rooms: ["bathroom"] },
      {
        id: "zone.living",
        name: "Living Areas",
        order: 3,
        rooms: ["living room", "hallway", "entry"],
      },
      {
        id: "zone.bed",
        name: "Bedrooms",
        order: 4,
        rooms: ["bedroom", "closets"],
      },
    ],
    tasks: [
      // Zone: Kitchen (deep-ish weekly)
      {
        id: "task.weekly.kitchen.counters",
        label: "Kitchen: wipe counters + backsplash + appliance fronts",
        zoneId: "zone.kitchen",
        category: CATEGORY.kitchen,
        estMins: 12,
        effort: 3,
        tools: [TOOL.microfiber, TOOL.sponge],
        supplies: [SUPPLY.allPurpose, SUPPLY.degreaser],
        constraints: { quietOk: true, sabbathOk: true },
        instructions: [
          "Clear counters.",
          "Spray and wipe counters + backsplash.",
          "Wipe appliance fronts (microwave/fridge).",
        ],
      },
      {
        id: "task.weekly.kitchen.sink",
        label: "Kitchen: scrub sink + sanitize drain area",
        zoneId: "zone.kitchen",
        category: CATEGORY.sanitize,
        estMins: 8,
        effort: 3,
        tools: [TOOL.scrubBrush],
        supplies: [SUPPLY.bakingSoda, SUPPLY.vinegar, SUPPLY.disinfect],
        constraints: { quietOk: true, sabbathOk: true },
        instructions: [
          "Sprinkle baking soda, scrub sink.",
          "Rinse, then vinegar rinse if desired.",
          "Disinfect faucet handles and drain area.",
        ],
      },
      {
        id: "task.weekly.kitchen.floor",
        label: "Kitchen: sweep + mop",
        zoneId: "zone.kitchen",
        category: CATEGORY.floors,
        estMins: 12,
        effort: 4,
        tools: [TOOL.broom, TOOL.mop, TOOL.bucket],
        supplies: [SUPPLY.floorCleaner],
        constraints: { quietOk: true, sabbathOk: true },
        instructions: [
          "Sweep thoroughly.",
          "Mop floor (edges first, then center).",
        ],
      },

      // Zone: Bathrooms
      {
        id: "task.weekly.bath.toilet",
        label: "Bathroom: scrub toilet bowl + disinfect exterior",
        zoneId: "zone.bath",
        category: CATEGORY.bathroom,
        estMins: 10,
        effort: 4,
        tools: [TOOL.toiletBrush, TOOL.microfiber, TOOL.gloves],
        supplies: [SUPPLY.toilet, SUPPLY.disinfect],
        constraints: { quietOk: true, sabbathOk: true },
        instructions: [
          "Apply toilet cleaner, scrub bowl.",
          "Disinfect exterior surfaces (handle, lid, base).",
        ],
      },
      {
        id: "task.weekly.bath.sink.mirror",
        label: "Bathroom: clean sink + mirror",
        zoneId: "zone.bath",
        category: CATEGORY.sanitize,
        estMins: 8,
        effort: 3,
        tools: [TOOL.microfiber],
        supplies: [SUPPLY.bathroom, SUPPLY.glass],
        constraints: { quietOk: true, sabbathOk: true },
        instructions: [
          "Wipe sink + faucet.",
          "Spray mirror, wipe streak-free.",
        ],
      },
      {
        id: "task.weekly.bath.shower",
        label: "Bathroom: scrub tub/shower quick pass",
        zoneId: "zone.bath",
        category: CATEGORY.deep,
        estMins: 12,
        effort: 4,
        tools: [TOOL.scrubBrush, TOOL.sponge],
        supplies: [SUPPLY.bathroom],
        constraints: { quietOk: true, sabbathOk: true },
        instructions: [
          "Spray cleaner.",
          "Scrub high-splash areas.",
          "Rinse/wipe dry if desired.",
        ],
      },
      {
        id: "task.weekly.bath.floor",
        label: "Bathroom: sweep + mop",
        zoneId: "zone.bath",
        category: CATEGORY.floors,
        estMins: 8,
        effort: 3,
        tools: [TOOL.broom, TOOL.mop],
        supplies: [SUPPLY.floorCleaner],
        constraints: { quietOk: true, sabbathOk: true },
        instructions: ["Sweep corners.", "Mop, focusing around toilet."],
      },

      // Zone: Living Areas
      {
        id: "task.weekly.living.dust",
        label: "Living areas: dust surfaces (tops → bottoms)",
        zoneId: "zone.living",
        category: CATEGORY.dust,
        estMins: 10,
        effort: 2,
        tools: [TOOL.duster, TOOL.microfiber],
        supplies: [SUPPLY.allPurpose],
        constraints: { quietOk: true, sabbathOk: true },
        instructions: [
          "Dust shelves, TV stand, frames.",
          "Wipe coffee table + side tables.",
        ],
      },
      {
        id: "task.weekly.living.floors",
        label: "Living areas: vacuum/sweep + spot mop",
        zoneId: "zone.living",
        category: CATEGORY.floors,
        estMins: 15,
        effort: 4,
        tools: [TOOL.vacuum, TOOL.broom, TOOL.mop],
        supplies: [SUPPLY.floorCleaner],
        constraints: { quietOk: false, sabbathOk: true },
        instructions: [
          "Vacuum rugs/carpets or sweep hard floors.",
          "Spot mop sticky areas.",
        ],
      },
      {
        id: "task.weekly.living.entry",
        label: "Entry/hall: reset shoes + wipe handles",
        zoneId: "zone.living",
        category: CATEGORY.tidy,
        estMins: 8,
        effort: 2,
        tools: [TOOL.microfiber],
        supplies: [SUPPLY.disinfect],
        constraints: { quietOk: true, sabbathOk: true },
        instructions: [
          "Return shoes to rack.",
          "Disinfect door knobs + light switches.",
        ],
      },

      // Zone: Bedrooms
      {
        id: "task.weekly.bed.linens",
        label: "Bedrooms: change bed linens",
        zoneId: "zone.bed",
        category: CATEGORY.laundry,
        estMins: 12,
        effort: 3,
        tools: [],
        supplies: [],
        constraints: {
          quietOk: true,
          sabbathOk: true,
          requiresMachine: "washer",
        },
        instructions: [
          "Strip beds.",
          "Start wash load.",
          "Remake beds with fresh linens.",
        ],
      },
      {
        id: "task.weekly.bed.tidy",
        label: "Bedrooms: clear floors + surfaces",
        zoneId: "zone.bed",
        category: CATEGORY.declutter,
        estMins: 10,
        effort: 2,
        tools: [TOOL.laundryBasket],
        supplies: [],
        constraints: { quietOk: true, sabbathOk: true },
        instructions: [
          "Pick up clothes.",
          "Return items to drawers/closets.",
          "Clear nightstands.",
        ],
      },
      {
        id: "task.weekly.bed.floor",
        label: "Bedrooms: vacuum/sweep",
        zoneId: "zone.bed",
        category: CATEGORY.floors,
        estMins: 10,
        effort: 3,
        tools: [TOOL.vacuum, TOOL.broom],
        supplies: [],
        constraints: { quietOk: false, sabbathOk: true },
        instructions: [
          "Vacuum carpets or sweep hard floors.",
          "Hit corners/under bed if accessible.",
        ],
      },
    ],
    rules: {
      schedule: {
        cadence: "weekly",
        days: ["Mon", "Tue", "Wed", "Thu"],
        restDays: ["Fri", "Sat", "Sun"],
      },
      rotation: {
        zoneOrder: ["zone.kitchen", "zone.bath", "zone.living", "zone.bed"],
        mode: "byDay",
      },
    },
  },

  {
    id: "clean.deep.monthly.wholehome.v1",
    name: "Monthly Deep Clean (Whole Home)",
    version: 1,
    tags: ["monthly", "deep", "whole-home"],
    description:
      "A monthly deep clean focusing on detail work: baseboards, vents, inside appliances, and neglected corners.",
    defaults: {
      durationMins: 120,
      intensity: "heavy",
      sabbathAware: true,
      quietHours: { start: "22:00", end: "07:00", deferTo: "08:00" },
      allowLoudTools: true,
      allowMachines: true,
    },
    zones: [
      { id: "zone.kitchen", name: "Kitchen", order: 1, rooms: ["kitchen"] },
      { id: "zone.bath", name: "Bathrooms", order: 2, rooms: ["bathroom"] },
      {
        id: "zone.living",
        name: "Living Areas",
        order: 3,
        rooms: ["living room", "hallway"],
      },
      { id: "zone.bed", name: "Bedrooms", order: 4, rooms: ["bedroom"] },
    ],
    tasks: [
      {
        id: "task.monthly.baseboards",
        label: "Whole home: wipe baseboards + door trim",
        category: CATEGORY.deep,
        estMins: 25,
        effort: 4,
        tools: [TOOL.microfiber],
        supplies: [SUPPLY.allPurpose],
        constraints: { quietOk: true, sabbathOk: true },
        instructions: [
          "Start at one end of home.",
          "Wipe trim/baseboards with damp cloth.",
          "Dry wipe if needed.",
        ],
      },
      {
        id: "task.monthly.vents",
        label: "Whole home: dust vents + ceiling fans",
        category: CATEGORY.deep,
        estMins: 20,
        effort: 3,
        tools: [TOOL.duster, TOOL.microfiber],
        supplies: [],
        constraints: { quietOk: true, sabbathOk: true },
        instructions: [
          "Dust vent covers.",
          "Dust ceiling fans (use pillowcase trick if desired).",
        ],
      },
      {
        id: "task.monthly.kitchen.inside",
        label:
          "Kitchen: clean inside microwave + wipe inside fridge shelf edges",
        zoneId: "zone.kitchen",
        category: CATEGORY.deep,
        estMins: 20,
        effort: 4,
        tools: [TOOL.sponge, TOOL.microfiber],
        supplies: [SUPPLY.degreaser, SUPPLY.allPurpose],
        constraints: { quietOk: true, sabbathOk: true },
        instructions: [
          "Steam microwave with water bowl.",
          "Wipe interior.",
          "Wipe fridge shelf edges and drawers fronts.",
        ],
      },
      {
        id: "task.monthly.bath.grout",
        label: "Bathroom: focus scrub (grout/edges/behind toilet)",
        zoneId: "zone.bath",
        category: CATEGORY.deep,
        estMins: 20,
        effort: 5,
        tools: [TOOL.scrubBrush, TOOL.gloves],
        supplies: [SUPPLY.bathroom],
        constraints: { quietOk: true, sabbathOk: true },
        instructions: [
          "Scrub grout/edges.",
          "Hit behind toilet and base.",
          "Rinse/wipe.",
        ],
      },
      {
        id: "task.monthly.living.upholstery",
        label: "Living: vacuum upholstery + under cushions",
        zoneId: "zone.living",
        category: CATEGORY.deep,
        estMins: 15,
        effort: 3,
        tools: [TOOL.vacuum],
        supplies: [],
        constraints: { quietOk: false, sabbathOk: true },
        instructions: [
          "Remove cushions.",
          "Vacuum crumbs and seams.",
          "Replace cushions neatly.",
        ],
      },
      {
        id: "task.monthly.bed.closets",
        label: "Bedrooms: quick closet sweep + donation bag",
        zoneId: "zone.bed",
        category: CATEGORY.declutter,
        estMins: 20,
        effort: 3,
        tools: [TOOL.trashBags],
        supplies: [],
        constraints: { quietOk: true, sabbathOk: true },
        instructions: [
          "Set donation bag.",
          "Pull 5 items to donate.",
          "Straighten hangers/shoes.",
        ],
      },
    ],
    rules: { schedule: { cadence: "monthly", recommendedWeek: 1 } },
  },

  {
    id: "clean.moveout.reset.v1",
    name: "Move-Out / Turnover Clean (Checklist)",
    version: 1,
    tags: ["move-out", "deep", "checklist"],
    description:
      "A full turnover clean for an empty or nearly-empty home: cabinets, appliances, walls, and floors.",
    defaults: {
      durationMins: 360,
      intensity: "heavy",
      sabbathAware: false,
      quietHours: { start: "22:00", end: "07:00", deferTo: "08:00" },
      allowLoudTools: true,
      allowMachines: true,
    },
    zones: [
      {
        id: "zone.kitchen",
        name: "Kitchen",
        order: 1,
        rooms: ["kitchen", "pantry"],
      },
      { id: "zone.bath", name: "Bathrooms", order: 2, rooms: ["bathroom"] },
      {
        id: "zone.living",
        name: "Living Areas",
        order: 3,
        rooms: ["living room", "hallway", "entry"],
      },
      {
        id: "zone.bed",
        name: "Bedrooms",
        order: 4,
        rooms: ["bedroom", "closets"],
      },
    ],
    tasks: [
      {
        id: "task.turnover.cabinets",
        label: "Kitchen: clean inside/out cabinets + drawers",
        zoneId: "zone.kitchen",
        category: CATEGORY.deep,
        estMins: 60,
        effort: 5,
        tools: [TOOL.microfiber, TOOL.sponge],
        supplies: [SUPPLY.allPurpose, SUPPLY.degreaser],
        constraints: { quietOk: true, sabbathOk: true },
        instructions: [
          "Empty cabinets.",
          "Wipe inside/out.",
          "Dry wipe and leave doors open briefly.",
        ],
      },
      {
        id: "task.turnover.appliances",
        label: "Kitchen: deep clean fridge/oven/microwave",
        zoneId: "zone.kitchen",
        category: CATEGORY.deep,
        estMins: 90,
        effort: 5,
        tools: [TOOL.sponge, TOOL.scrubBrush],
        supplies: [SUPPLY.degreaser, SUPPLY.bakingSoda],
        constraints: { quietOk: true, sabbathOk: true },
        instructions: [
          "Remove shelves/drawers.",
          "Scrub and wipe.",
          "Polish exterior.",
        ],
      },
      {
        id: "task.turnover.bath.full",
        label: "Bathrooms: full scrub (tub/shower/toilet/vanity)",
        zoneId: "zone.bath",
        category: CATEGORY.deep,
        estMins: 90,
        effort: 5,
        tools: [TOOL.scrubBrush, TOOL.toiletBrush, TOOL.gloves],
        supplies: [SUPPLY.bathroom, SUPPLY.toilet, SUPPLY.disinfect],
        constraints: { quietOk: true, sabbathOk: true },
        instructions: [
          "Scrub all surfaces.",
          "Rinse/wipe dry.",
          "Disinfect touch points.",
        ],
      },
      {
        id: "task.turnover.walls",
        label: "Whole home: spot-clean walls + switches + doors",
        category: CATEGORY.deep,
        estMins: 60,
        effort: 4,
        tools: [TOOL.microfiber],
        supplies: [SUPPLY.allPurpose],
        constraints: { quietOk: true, sabbathOk: true },
        instructions: [
          "Wipe switches/handles.",
          "Spot-clean smudges on walls/doors.",
        ],
      },
      {
        id: "task.turnover.floors",
        label: "Whole home: vacuum + mop (edges + corners)",
        category: CATEGORY.floors,
        estMins: 60,
        effort: 5,
        tools: [TOOL.vacuum, TOOL.mop, TOOL.bucket],
        supplies: [SUPPLY.floorCleaner],
        constraints: { quietOk: false, sabbathOk: true },
        instructions: [
          "Vacuum thoroughly.",
          "Mop from farthest room toward exit.",
        ],
      },
    ],
    rules: { schedule: { cadence: "one-off" } },
  },

  {
    id: "clean.sabbath.light.v1",
    name: "Sabbath-Friendly Light Care (10–20 min)",
    version: 1,
    tags: ["sabbath", "quiet", "light", "maintenance"],
    description:
      "Light, quiet tasks suitable for restful days: tidy, wipe, and reset without loud tools or heavy scrubbing.",
    defaults: {
      durationMins: 15,
      intensity: "light",
      sabbathAware: true,
      quietHours: { start: "22:00", end: "08:00", deferTo: "09:00" },
      allowLoudTools: false,
      allowMachines: false,
    },
    zones: [
      {
        id: "zone.common",
        name: "Common Areas",
        order: 1,
        rooms: ["kitchen", "living room", "entry"],
      },
      { id: "zone.bath", name: "Bathroom", order: 2, rooms: ["bathroom"] },
    ],
    tasks: [
      {
        id: "task.sabbath.tidy",
        label: "Tidy: return items to homes (no re-org)",
        zoneId: "zone.common",
        category: CATEGORY.tidy,
        estMins: 7,
        effort: 1,
        tools: [],
        supplies: [],
        constraints: { quietOk: true, sabbathOk: true },
        instructions: [
          "Clear visible clutter to its home.",
          "Stop at 'good enough'.",
        ],
      },
      {
        id: "task.sabbath.wipe",
        label: "Wipe: counters + table (gentle wipe)",
        zoneId: "zone.common",
        category: CATEGORY.sanitize,
        estMins: 5,
        effort: 1,
        tools: [TOOL.microfiber],
        supplies: [SUPPLY.allPurpose],
        constraints: { quietOk: true, sabbathOk: true },
        instructions: [
          "Dampen cloth, wipe surfaces.",
          "Avoid heavy scrubbing.",
        ],
      },
      {
        id: "task.sabbath.bath.touch",
        label: "Bathroom touch-up: wipe sink + handle",
        zoneId: "zone.bath",
        category: CATEGORY.bathroom,
        estMins: 5,
        effort: 1,
        tools: [TOOL.microfiber],
        supplies: [SUPPLY.bathroom],
        constraints: { quietOk: true, sabbathOk: true },
        instructions: ["Wipe sink/faucet.", "Wipe toilet handle (light)."],
      },
    ],
    rules: { schedule: { cadence: "weekly", recommendedDay: "Sat" } },
  },
];

/* -----------------------------------------------------------------------------
 * Instantiation + blueprint conversion
 * -------------------------------------------------------------------------- */

/**
 * listTemplates(filters?)
 * @param {object} [filters]
 * @param {string|string[]} [filters.tag]
 * @param {string} [filters.query]
 */
export function listTemplates(filters = {}) {
  const f = safeObject(filters);
  const tag = f.tag
    ? safeArray(Array.isArray(f.tag) ? f.tag : [f.tag]).map((t) =>
        String(t).toLowerCase()
      )
    : null;
  const q = f.query ? String(f.query).toLowerCase().trim() : null;

  return TEMPLATES.filter((t) => {
    if (tag && tag.length) {
      const tags = safeArray(t.tags).map((x) => String(x).toLowerCase());
      const ok = tag.some((needle) => tags.includes(needle));
      if (!ok) return false;
    }
    if (q) {
      const blob = [t.id, t.name, t.description, ...(t.tags || [])]
        .join(" ")
        .toLowerCase();
      if (!blob.includes(q)) return false;
    }
    return true;
  });
}

/**
 * getTemplate(id)
 */
export function getTemplate(id) {
  const key = String(id || "").trim();
  return TEMPLATES.find((t) => t.id === key) || null;
}

/**
 * instantiateTemplate(id, overrides)
 * - Returns a concrete "plan" object (household/user can modify later).
 */
export function instantiateTemplate(id, overrides = {}) {
  const tpl = getTemplate(id);
  if (!tpl) throw new Error(`CleanPlanTemplates: unknown template id "${id}"`);

  const ov = safeObject(overrides);

  // planId stable-ish for created instances
  const planId = ov.planId || genId("cleanplan");

  const plan = {
    planId,
    templateId: tpl.id,
    templateVersion: tpl.version,
    createdAt: nowMs(),
    updatedAt: nowMs(),

    name: ov.name || tpl.name,
    description: ov.description || tpl.description,
    tags: Array.from(
      new Set([...(tpl.tags || []), ...(safeArray(ov.tags) || [])])
    ),

    // preferences
    settings: deepMerge(tpl.defaults || {}, ov.settings || {}),

    // structure
    zones: safeArray(ov.zones).length
      ? safeArray(ov.zones)
      : safeArray(tpl.zones),
    tasks: safeArray(ov.tasks).length
      ? safeArray(ov.tasks)
      : safeArray(tpl.tasks),

    // scheduling rules (optional)
    rules: deepMerge(tpl.rules || {}, ov.rules || {}),

    // linkage for the SSA "web of meaning"
    meta: deepMerge(
      {
        domain: "cleaning",
        library: "CleanPlanTemplates",
        libraryVersion: LIB_VERSION,
      },
      ov.meta || {}
    ),
  };

  return plan;
}

/**
 * toSessionBlueprint(plan, opts)
 * - Converts a plan into a session blueprint compatible with your SessionRunner patterns.
 * - This is conservative: a flat ordered list of steps.
 *
 * @param {object} plan - instantiated plan object
 * @param {object} [opts]
 * @param {string} [opts.zoneId] - limit to one zone
 * @param {number} [opts.maxMins] - clamp total time by dropping lowest priority tasks
 * @param {boolean} [opts.quietMode] - drop tasks that are not quietOk
 * @param {boolean} [opts.sabbathMode] - drop tasks not sabbathOk
 */
export function toSessionBlueprint(plan, opts = {}) {
  const p = safeObject(plan);
  const o = safeObject(opts);

  const tasks = safeArray(p.tasks)
    .map((t) => safeObject(t))
    .filter((t) => t.id && t.label);

  // filter by zone
  const zoneId = o.zoneId ? String(o.zoneId) : null;
  let filtered = zoneId
    ? tasks.filter((t) => String(t.zoneId || "") === zoneId)
    : tasks;

  // quiet/sabbath filtering
  if (o.quietMode) {
    filtered = filtered.filter((t) => t?.constraints?.quietOk !== false);
  }
  if (o.sabbathMode) {
    filtered = filtered.filter((t) => t?.constraints?.sabbathOk !== false);
  }

  // Sort: by zone order then by estMins/effort (simple heuristic)
  const zoneOrder = {};
  for (const z of safeArray(p.zones))
    zoneOrder[String(z.id)] = Number(z.order || 999);

  filtered.sort((a, b) => {
    const az = zoneOrder[String(a.zoneId || "")] ?? 999;
    const bz = zoneOrder[String(b.zoneId || "")] ?? 999;
    if (az !== bz) return az - bz;
    const ae = Number(a.estMins || 0);
    const be = Number(b.estMins || 0);
    if (ae !== be) return ae - be;
    return String(a.label).localeCompare(String(b.label));
  });

  // Clamp by max minutes if requested:
  const maxMins = Number.isFinite(Number(o.maxMins)) ? Number(o.maxMins) : null;
  if (maxMins != null && maxMins > 0) {
    // Keep adding tasks until limit; prefer lower effort first
    const sorted = [...filtered].sort((a, b) => {
      const ae = Number(a.effort || 3);
      const be = Number(b.effort || 3);
      if (ae !== be) return ae - be;
      return Number(a.estMins || 0) - Number(b.estMins || 0);
    });
    const kept = [];
    let total = 0;
    for (const t of sorted) {
      const m = Number(t.estMins || 0);
      if (total + m > maxMins && kept.length) continue;
      kept.push(t);
      total += m;
      if (total >= maxMins) break;
    }
    // restore display order
    filtered = kept.sort((a, b) => {
      const az = zoneOrder[String(a.zoneId || "")] ?? 999;
      const bz = zoneOrder[String(b.zoneId || "")] ?? 999;
      if (az !== bz) return az - bz;
      return (
        Number(a.estMins || 0) - Number(b.estMins || 0) ||
        String(a.label).localeCompare(String(b.label))
      );
    });
  }

  // Convert to steps
  const steps = filtered.map((t, idx) => ({
    id: `step_${t.id}`,
    order: idx + 1,
    title: t.label,
    domain: "cleaning",
    category: t.category || CATEGORY.tidy,
    estMins: Number(t.estMins || 0),
    effort: Number(t.effort || 3),
    zoneId: t.zoneId || null,
    room: t.room || null,
    tools: safeArray(t.tools),
    supplies: safeArray(t.supplies),
    instructions: safeArray(t.instructions),
    constraints: safeObject(t.constraints),
    meta: {
      templateTaskId: t.id,
      templateId: p.templateId || null,
      planId: p.planId || null,
    },
  }));

  const totalMins = steps.reduce((sum, s) => sum + Number(s.estMins || 0), 0);

  return {
    id: genId("cleanSession"),
    domain: "cleaning",
    title: p.name || "Cleaning Session",
    createdAt: nowMs(),
    meta: {
      planId: p.planId || null,
      templateId: p.templateId || null,
      templateVersion: p.templateVersion || null,
      tags: safeArray(p.tags),
      settings: safeObject(p.settings),
      totalMins,
    },
    steps,
  };
}

/* -----------------------------------------------------------------------------
 * Default export (library object)
 * -------------------------------------------------------------------------- */

const CleanPlanTemplates = {
  LIB_VERSION,
  TOOL,
  SUPPLY,
  CATEGORY,
  templates: TEMPLATES,

  listTemplates,
  getTemplate,
  instantiateTemplate,
  toSessionBlueprint,
};

export default CleanPlanTemplates;
