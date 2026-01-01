// src/data/organizingStrategies.js
// Dynamic registry of organizing & housekeeping strategies for Suka Smart Assistant
// - Event-driven hooks (eventBus, automation)
// - Sabbath-aware scheduling guards
// - Deep Clean Focus per-task cadences (monthly/quarterly/bi-annual/annual)
// - Cross-module nudges (Cleaning, Meals, Garden, Inventory/Storehouse, Calendar)
// - Extensible: registerCustomStrategy(...)

const __now = () => new Date();

/* -----------------------------------------------------------------------------
   Defensive dynamic imports (safe in Vite/React). We degrade gracefully.
----------------------------------------------------------------------------- */
let eventBus = { emit: () => {}, on: () => () => {} };
let automation = { invoke: async () => {}, queue: () => {} };
let PreferencesStore, InventoryStore, CalendarStore;

let CleaningPlanManager = null;
let materializeCleaningPacks = null;

(async () => {
  try { ({ eventBus } = await import("@/services/events/eventBus")); } catch {}
  try { ({ automation } = await import("@/services/automation/runtime")); } catch {}
  try { ({ usePreferencesStore: PreferencesStore } = await import("@/stores/preferences")); } catch {}
  try { ({ useInventoryStore: InventoryStore } = await import("@/stores/inventory")); } catch {}
  try { ({ useCalendarStore: CalendarStore } = await import("@/stores/calendar")); } catch {}

  try { ({ default: CleaningPlanManager } = await import("@/managers/CleaningPlanManager")); } catch {}
  try {
    const t = await import("@/data/cleaningTemplates");
    materializeCleaningPacks = t?.materializePacks;
  } catch {}
})();

/* -----------------------------------------------------------------------------
   Utilities
----------------------------------------------------------------------------- */
const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
const toBool = (x, d = false) => (typeof x === "boolean" ? x : d);

const fmt = {
  id: (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, ""),
  title: (s) => s,
};

const isSabbath = (d = __now(), tz = "America/New_York", sabbathAware = true) => {
  if (!sabbathAware) return false;
  // Friday sunset to Saturday sunset. We approximate by day-of-week here; a later phase can use astronomical sunset.
  const dow = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: tz }).format(d);
  return dow === "Sat";
};

const rr = {
  // Simple RRULE builders; Calendar module can convert to VEVENT later.
  monthly: (byhour = 9, byminute = 0, bysecond = 0) =>
    `RRULE:FREQ=MONTHLY;BYHOUR=${byhour};BYMINUTE=${byminute};BYSECOND=${bysecond}`,
  quarterly: (byhour = 9, byminute = 0, bysecond = 0) =>
    `RRULE:FREQ=MONTHLY;INTERVAL=3;BYHOUR=${byhour};BYMINUTE=${byminute};BYSECOND=${bysecond}`,
  biannual: (byhour = 9, byminute = 0, bysecond = 0) =>
    `RRULE:FREQ=MONTHLY;INTERVAL=6;BYHOUR=${byhour};BYMINUTE=${byminute};BYSECOND=${bysecond}`,
  annual: (byhour = 9, byminute = 0, bysecond = 0) =>
    `RRULE:FREQ=YEARLY;BYHOUR=${byhour};BYMINUTE=${byminute};BYSECOND=${bysecond}`,
  weekly: (byhour = 9, byminute = 0, bysecond = 0) =>
    `RRULE:FREQ=WEEKLY;BYHOUR=${byhour};BYMINUTE=${byminute};BYSECOND=${bysecond}`,
  daily: (byhour = 20, byminute = 0, bysecond = 0) =>
    `RRULE:FREQ=DAILY;BYHOUR=${byhour};BYMINUTE=${byminute};BYSECOND=${bysecond}`,
};

const deepCleanCadenceToRRULE = (cadence) => {
  switch ((cadence || "").toLowerCase()) {
    case "monthly": return rr.monthly();
    case "quarterly": return rr.quarterly();
    case "bi-annual":
    case "biannual": return rr.biannual();
    case "annual": return rr.annual();
    default: return rr.annual();
  }
};

const prefer = {
  profile: () => {
    try { return PreferencesStore?.getState?.()?.profile || {}; } catch { return {}; }
  },
  tz: () => {
    try { return PreferencesStore?.getState?.()?.timezone || "America/New_York"; } catch { return "America/New_York"; }
  },
  sabbathAware: () => {
    try { return toBool(PreferencesStore?.getState?.()?.sabbathAware, true); } catch { return true; }
  },
};

/* -----------------------------------------------------------------------------
   Strategy schema
   {
     id, name, icon, description, tags: [],
     areas: ["kitchen","bath","storehouse","office","laundry","garden","entry","bedrooms","living"],
     generator: (ctx) => { tasks: [{id,title,area,estMinutes,priority,dependsOn:[], cadence?: "weekly"|"monthly"|... }], links: {...} },
     schedule: (ctx) => { rrule, dtstart?, disabledOnSabbath?:boolean },
     smartSuggest: (ctx) => number 0..100 relevance score,
     onMaterialized: (payload, ctx) => void  // emits events, kicks agents
   }
----------------------------------------------------------------------------- */
const REGISTRY = new Map();

/* -----------------------------------------------------------------------------
   Built-in strategies
----------------------------------------------------------------------------- */

// 1) Daily Reset (5–20 minutes per zone)
REGISTRY.set("daily-reset", {
  id: "daily-reset",
  name: "Daily Reset",
  icon: "RefreshCcw",
  description:
    "Fast evening reset across high-traffic zones. Dishes, counters, hotspots, floors. Keeps chaos low and mornings calm.",
  tags: ["daily", "reset", "routines", "intuitive", "low-effort"],
  areas: ["kitchen", "entry", "living", "bath", "bedrooms"],
  generator: (ctx = {}) => {
    const zones = ctx.zones?.length ? ctx.zones : ["entry", "kitchen", "living", "bath"];
    const est = (z) => (z === "kitchen" ? 15 : 8);
    const tasks = zones.map((z, i) => ({
      id: `daily-${z}-${i}`,
      title: `Reset ${z} (surfaces, put-away, quick sweep)`,
      area: z,
      estMinutes: est(z),
      priority: 2,
      dependsOn: [],
      cadence: "daily",
      kpis: { streakEligible: true },
    }));
    return { tasks, links: { tips: ["Use a laundry basket as a catch-all, then sort at hub."], ui: { progressBar: true } } };
  },
  schedule: (ctx = {}) => {
    const tz = prefer.tz();
    const sabbathAware = prefer.sabbathAware();
    return {
      rrule: rr.daily(20, 0, 0),
      tz,
      disabledOnSabbath: sabbathAware,
    };
  },
  smartSuggest: (ctx = {}) => {
    const household = prefer.profile();
    const hasKids = !!household?.members?.some?.(m => (m.age || 0) < 12);
    return 70 + (hasKids ? 20 : 0);
  },
  onMaterialized: (payload) => {
    eventBus.emit("organizing:materialized", { strategyId: "daily-reset", ...payload });
  },
});

// 2) Paper Inbox Zero (weekly)
REGISTRY.set("paper-inbox-zero", {
  id: "paper-inbox-zero",
  name: "Paper Inbox Zero",
  icon: "Inbox",
  description:
    "One basket for all papers. Once a week: sort, scan/photograph, file, shred. Cut mental clutter and late fees.",
  tags: ["office", "paperless", "weekly"],
  areas: ["office"],
  generator: () => {
    const tasks = [
      { id: "paper-collect", title: "Collect & sort inbox (bills, forms, notes)", area: "office", estMinutes: 15, priority: 2, cadence: "weekly" },
      { id: "paper-digitize", title: "Scan/photograph and name files", area: "office", estMinutes: 20, priority: 2, cadence: "weekly" },
      { id: "paper-file", title: "File essentials; shred junk", area: "office", estMinutes: 10, priority: 3, cadence: "weekly" },
    ];
    return { tasks, links: { tools: ["CamScanner or phone notes scanner"], ui: { checklist: true } } };
  },
  schedule: (ctx = {}) => ({ rrule: rr.weekly(17, 0, 0), tz: prefer.tz(), disabledOnSabbath: prefer.sabbathAware() }),
  smartSuggest: () => 65,
  onMaterialized: (payload) => eventBus.emit("organizing:materialized", { strategyId: "paper-inbox-zero", ...payload }),
});

// 3) Laundry Flow (daily/bi-daily)
REGISTRY.set("laundry-flow", {
  id: "laundry-flow",
  name: "Laundry Flow",
  icon: "Repeat",
  description:
    "Right-size laundry cadence. Pre-sort hampers, set timed alerts: wash → dry → fold → put away in one mini-pipeline.",
  tags: ["laundry", "pipeline", "daily"],
  areas: ["laundry", "bedrooms"],
  generator: (ctx = {}) => {
    const loadsPerDay = clamp(ctx?.loadsPerDay ?? 1, 1, 4);
    const tasks = Array.from({ length: loadsPerDay }).flatMap((_, i) => ([
      { id: `laundry-wash-${i}`, title: `Start Load #${i + 1}`, area: "laundry", estMinutes: 5, priority: 2, cadence: "daily" },
      { id: `laundry-dry-${i}`, title: `Move Load #${i + 1} to dry`, area: "laundry", estMinutes: 5, priority: 2, cadence: "daily", dependsOn: [`laundry-wash-${i}`] },
      { id: `laundry-fold-${i}`, title: `Fold & put away #${i + 1}`, area: "bedrooms", estMinutes: 15, priority: 2, cadence: "daily", dependsOn: [`laundry-dry-${i}`] },
    ]));
    return { tasks, links: { tips: ["Set phone timers at each handoff."], ui: { timeline: true } } };
  },
  schedule: () => ({ rrule: rr.daily(8, 0, 0), tz: prefer.tz(), disabledOnSabbath: prefer.sabbathAware() }),
  smartSuggest: () => 75,
  onMaterialized: (payload) => eventBus.emit("organizing:materialized", { strategyId: "laundry-flow", ...payload }),
});

// 4) Storehouse Rotation (FIFO) – Inventory integration
REGISTRY.set("storehouse-fifo", {
  id: "storehouse-fifo",
  name: "Storehouse Rotation (FIFO)",
  icon: "RefreshCw",
  description:
    "Keep pantry/freezer/root cellar fresh. First-in-first-out shelf maps, label dates, and low-stock nudges.",
  tags: ["storehouse", "inventory", "kitchen", "weekly"],
  areas: ["storehouse", "kitchen"],
  generator: (ctx = {}) => {
    const inv = InventoryStore?.getState?.()?.items || [];
    const nearing = inv.filter(i => (i?.daysToExpire ?? 999) <= 30).slice(0, 12);
    const tasks = [
      { id: "fifo-audit", title: "Quick shelf audit (near-expiry first)", area: "storehouse", estMinutes: 15, priority: 2, cadence: "weekly" },
      ...nearing.map((i, idx) => ({
        id: `fifo-move-${i.id || idx}`,
        title: `Move ${i.name} to front / add to meal plan`,
        area: "storehouse",
        estMinutes: 2,
        priority: 2,
        cadence: "weekly",
      })),
      { id: "fifo-label", title: "Label new items with date; update map", area: "storehouse", estMinutes: 10, priority: 2, cadence: "weekly" },
    ];
    return { tasks, links: { ui: { inventoryPeek: true }, tips: ["Group by category; oldest to front."] } };
  },
  schedule: () => ({ rrule: rr.weekly(10, 0, 0), tz: prefer.tz(), disabledOnSabbath: prefer.sabbathAware() }),
  smartSuggest: () => 80,
  onMaterialized: (payload) => {
    eventBus.emit("inventory:rotation:materialized", payload);
    automation.queue?.("MealPlanner:AddNearExpiryToSuggestions", { source: "storehouse-fifo" });
  },
});

// 5) Garden Harvest → Pantry Handoff – Garden + Inventory + Calendar
REGISTRY.set("garden-to-pantry", {
  id: "garden-to-pantry",
  name: "Harvest → Pantry Handoff",
  icon: "Leaf",
  description:
    "Sync harvest logs to Storehouse. Wash, portion, preserve (can/dry/freeze), update inventory & labels.",
  tags: ["garden", "preservation", "inventory", "weekly"],
  areas: ["garden", "kitchen", "storehouse"],
  generator: (ctx = {}) => {
    const harvests = ctx?.harvests || []; // or GardenStore?.getState()?.recentHarvests
    const tasks = [
      { id: "harvest-wash", title: "Wash & inspect harvest", area: "kitchen", estMinutes: 15, priority: 2, cadence: "weekly" },
      { id: "harvest-portion", title: "Portion for fresh use vs preserve", area: "kitchen", estMinutes: 10, priority: 2, cadence: "weekly" },
      { id: "harvest-preserve", title: "Can/Dry/Freeze as planned", area: "kitchen", estMinutes: 30, priority: 2, cadence: "weekly" },
      { id: "harvest-inventory", title: "Update Storehouse inventory & labels", area: "storehouse", estMinutes: 10, priority: 2, cadence: "weekly" },
    ].concat(
      harvests.slice(0, 8).map((h, idx) => ({
        id: `harvest-item-${idx}`,
        title: `Process ${h.item} (${h.qty})`,
        area: "kitchen",
        estMinutes: 5,
        priority: 2,
        cadence: "weekly",
      }))
    );
    return { tasks, links: { ui: { gardenPeek: true, inventoryPeek: true } } };
  },
  schedule: () => ({ rrule: rr.weekly(16, 0, 0), tz: prefer.tz(), disabledOnSabbath: prefer.sabbathAware() }),
  smartSuggest: () => 60,
  onMaterialized: (payload) => {
    eventBus.emit("garden:handoff:materialized", payload);
    automation.queue?.("Inventory:SyncFromHarvestLog", { mode: "append" });
  },
});

// 6) Bug-Shield Perimeter – ties to your cleaning packs
REGISTRY.set("bug-shield-perimeter", {
  id: "bug-shield-perimeter",
  name: "Bug-Shield Perimeter",
  icon: "Shield",
  description:
    "Seal & deter: entry points, crumb lines, pet bowls, trash seals; perimeter sweep & wipe; traps/monitoring.",
  tags: ["cleaning", "health", "monthly"],
  areas: ["kitchen", "entry", "exterior"],
  generator: (ctx = {}) => {
    const tasks = [
      { id: "bug-entry", title: "Check & seal entry points (doors/vents/gaps)", area: "entry", estMinutes: 15, priority: 3, cadence: "monthly" },
      { id: "bug-crumbs", title: "Crumb-line wipe & behind appliances", area: "kitchen", estMinutes: 15, priority: 3, cadence: "monthly" },
      { id: "bug-bowls", title: "Pet bowls/feeding mats deep clean", area: "kitchen", estMinutes: 10, priority: 2, cadence: "monthly" },
      { id: "bug-trash", title: "Trash cans wash/bleach, lids seal check", area: "kitchen", estMinutes: 10, priority: 3, cadence: "monthly" },
      { id: "bug-traps", title: "Refresh traps & monitoring cards", area: "entry", estMinutes: 5, priority: 2, cadence: "monthly" },
    ];
    return { tasks, links: { packs: { canUseCleaningPack: !!materializeCleaningPacks } } };
  },
  schedule: () => ({ rrule: rr.monthly(11, 0, 0), tz: prefer.tz(), disabledOnSabbath: prefer.sabbathAware() }),
  smartSuggest: () => 55,
  onMaterialized: (payload) => {
    if (materializeCleaningPacks) {
      try { materializeCleaningPacks?.(["bugShieldBasics"]); } catch {}
    }
    eventBus.emit("cleaning:bugshield:materialized", payload);
  },
});

// 7) Appliance Care (Quarterly)
REGISTRY.set("appliance-care", {
  id: "appliance-care",
  name: "Appliance Care",
  icon: "Wrench",
  description:
    "Quarterly care: fridge coils, dishwasher filter, washer clean cycle, dryer vent, oven self-clean review.",
  tags: ["appliances", "quarterly", "maintenance"],
  areas: ["kitchen", "laundry"],
  generator: () => {
    const tasks = [
      { id: "appl-fridge", title: "Vacuum fridge coils / check seals", area: "kitchen", estMinutes: 10, priority: 3, cadence: "quarterly" },
      { id: "appl-dw", title: "Clean dishwasher filter & run clean cycle", area: "kitchen", estMinutes: 10, priority: 3, cadence: "quarterly" },
      { id: "appl-washer", title: "Washer tub clean cycle", area: "laundry", estMinutes: 5, priority: 2, cadence: "quarterly" },
      { id: "appl-dryer", title: "Dryer vent check & lint trap deep clean", area: "laundry", estMinutes: 10, priority: 3, cadence: "quarterly" },
      { id: "appl-oven", title: "Oven self-clean review / grease filter", area: "kitchen", estMinutes: 5, priority: 2, cadence: "quarterly" },
    ];
    return { tasks, links: { ui: { checklist: true } } };
  },
  schedule: () => ({ rrule: rr.quarterly(14, 0, 0), tz: prefer.tz(), disabledOnSabbath: prefer.sabbathAware() }),
  smartSuggest: () => 58,
  onMaterialized: (payload) => eventBus.emit("maintenance:appliance:materialized", payload),
});

// 8) Deep Clean Focus (per-task cadences; monthly/quarterly/bi-annual/annual)
REGISTRY.set("deep-clean-focus", {
  id: "deep-clean-focus",
  name: "Deep Clean Focus",
  icon: "Sparkles",
  description:
    "Rotating deep-clean tasks by area with independent cadences. Great for the new ‘Generate Routine’ flow.",
  tags: ["deep-clean", "focus", "custom-cadence"],
  areas: ["kitchen", "bath", "bedrooms", "living", "laundry", "entry"],
  generator: (ctx = {}) => {
    // Users can pass: ctx.tasks = [{ title, area, cadence, estMinutes, priority }]
    const defaults = [
      { title: "Baseboards & door frames", area: "living", cadence: "quarterly", estMinutes: 25, priority: 2 },
      { title: "Inside fridge & seals", area: "kitchen", cadence: "monthly", estMinutes: 30, priority: 3 },
      { title: "Windows & tracks", area: "bedrooms", cadence: "bi-annual", estMinutes: 40, priority: 2 },
      { title: "Tile grout scrub & reseal check", area: "bath", cadence: "bi-annual", estMinutes: 35, priority: 3 },
      { title: "Mattress rotate & vacuum", area: "bedrooms", cadence: "quarterly", estMinutes: 20, priority: 2 },
      { title: "Entry closet reset", area: "entry", cadence: "annual", estMinutes: 30, priority: 2 },
    ];
    const input = Array.isArray(ctx.tasks) && ctx.tasks.length ? ctx.tasks : defaults;
    const tasks = input.map((t, i) => ({
      id: `dcf-${fmt.id(t.title)}-${i}`,
      title: t.title,
      area: t.area,
      estMinutes: clamp(t.estMinutes ?? 30, 10, 120),
      priority: clamp(t.priority ?? 2, 1, 3),
      cadence: (t.cadence || "annual").toLowerCase(),
    }));
    return { tasks, links: { ui: { calendarPreview: true } } };
  },
  schedule: (ctx = {}) => {
    // This is the *default* for the *set*, but each task can be scheduled separately via materializer.
    return { rrule: rr.monthly(9, 0, 0), tz: prefer.tz(), disabledOnSabbath: prefer.sabbathAware() };
  },
  smartSuggest: () => 85,
  onMaterialized: ({ tasks }, ctx) => {
    // Create/queue calendar entries per task by cadence.
    tasks.forEach((t) => {
      const rrule = deepCleanCadenceToRRULE(t.cadence);
      eventBus.emit("calendar:create:rrule", {
        title: `Deep Clean: ${t.title}`,
        area: t.area,
        rrule,
        tz: prefer.tz(),
        meta: { source: "deep-clean-focus" },
      });
    });
    eventBus.emit("cleaning:deepfocus:materialized", { count: tasks?.length || 0 });
  },
});

/* -----------------------------------------------------------------------------
   Materializer & Suggestion Engine
----------------------------------------------------------------------------- */

function listStrategies() {
  return Array.from(REGISTRY.values());
}

function getStrategyById(id) {
  return REGISTRY.get(id) || null;
}

function suggestStrategies(context = {}) {
  // Score each via smartSuggest and return sorted
  const scored = listStrategies().map((s) => ({
    strategy: s,
    score: clamp((s.smartSuggest?.(context) ?? 50), 0, 100),
  }));
  return scored.sort((a, b) => b.score - a.score).map(x => x.strategy);
}

async function materializeStrategy(id, context = {}) {
  const strat = getStrategyById(id);
  if (!strat) throw new Error(`Unknown strategy: ${id}`);

  const sabbathAware = prefer.sabbathAware();
  if (isSabbath(__now(), prefer.tz(), sabbathAware) && toBool(context.blockOnSabbath, true)) {
    return {
      id,
      skipped: true,
      reason: "Sabbath guard",
      tasks: [],
      schedule: strat.schedule?.(context) || null,
    };
  }

  // Generate tasks
  const { tasks = [], links = {} } = strat.generator?.(context) || {};

  // Optionally push to CleaningPlan if present (for cleaning-type strategies).
  if (CleaningPlanManager && tasks.some(t => (t.area || "").length)) {
    try {
      const plan = CleaningPlanManager.createAdhocPlan?.({
        title: strat.name,
        tasks,
        meta: { strategyId: id, createdAt: new Date().toISOString() },
      });
      eventBus.emit("cleaning:plan:created", { planId: plan?.id, strategyId: id });
    } catch {}
  }

  const schedule = strat.schedule?.(context) || null;

  // Fire post-materialization hooks
  try { strat.onMaterialized?.({ tasks, schedule, links }, context); } catch {}

  // Cross-app nudges
  if (id === "storehouse-fifo") {
    automation.queue?.("UI:Nudge", {
      message: "We found near-expiry items. Add them to your Meal Plan?",
      actions: [{ label: "Open Meal Planner", event: "ui:navigate", to: "/tier2/household/meals" }],
      tone: "friendly",
    });
  }

  return { id, tasks, schedule, links, skipped: false };
}

/* -----------------------------------------------------------------------------
   Custom Strategy Registration
----------------------------------------------------------------------------- */
function registerCustomStrategy(strategy) {
  if (!strategy?.id) throw new Error("Custom strategy must include an id");
  const id = fmt.id(strategy.id);
  REGISTRY.set(id, { ...strategy, id });
  eventBus.emit("organizing:registry:updated", { id, op: "upsert" });
  return id;
}

/* -----------------------------------------------------------------------------
   Public API
----------------------------------------------------------------------------- */
export {
  listStrategies as getStrategies,
  getStrategyById,
  materializeStrategy,
  suggestStrategies,
  registerCustomStrategy,
  rr as RRULE,
  deepCleanCadenceToRRULE,
};

/* Default export for convenience */
export default {
  getStrategies: listStrategies,
  getStrategyById,
  materializeStrategy,
  suggestStrategies,
  registerCustomStrategy,
  RRULE: rr,
  deepCleanCadenceToRRULE,
};
