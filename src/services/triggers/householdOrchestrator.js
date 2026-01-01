// C:\Users\larho\suka-smart-assistant\src\services\triggers\householdOrchestrator.js
// Orchestrates household intuition (global + dynamic):
// - Listens for app/domain events (chat, approvals, inventory, calendar, devices, location, timers)
// - Pipes events through detectors (cooking, cleaning, etc.) and playbooks → user-friendly nudges
// - Sabbath-aware suggestions & daypart awareness (no US-only assumptions)
// - Garden ↔ Meals aware via existing planning services
// - Safe dynamic imports + agent contract shims (won’t crash if a module is missing)

/* ---------------------------------------
   Safe dynamic imports (no hard crashes)
----------------------------------------*/
async function safeImport(path) {
  try { return await import(/* @vite-ignore */ path); }
  catch { return {}; }
}

// Try multiple candidate paths (helps when some modules are folders with index.js)
async function safeImportMany(paths = []) {
  for (const p of paths) {
    try { return await import(/* @vite-ignore */ p); } catch {}
  }
  return {};
}

/* ---------------------------------------
   Events (fallback if not provided)
----------------------------------------*/
const FALLBACK_EVENTS = {
  SESSION: {
    PLANNED: {
      COOKING: "SESSION.PLANNED.COOKING",
      CLEANING: "SESSION.PLANNED.CLEANING",
      GARDENING: "SESSION.PLANNED.GARDENING",
    },
    STARTED: {
      COOKING: "SESSION.STARTED.COOKING",
      CLEANING: "SESSION.STARTED.CLEANING",
      GARDENING: "SESSION.STARTED.GARDENING",
    },
    FINISHED: {
      COOKING: "SESSION.FINISHED.COOKING",
      CLEANING: "SESSION.FINISHED.CLEANING",
      GARDENING: "SESSION.FINISHED.GARDENING",
    },
  },
  APPROVAL: {
    RECEIVED: "APPROVAL.RECEIVED",
    APPROVED: "APPROVAL.APPROVED",
    REJECTED: "APPROVAL.REJECTED",
  },
  INVENTORY: {
    SURPLUS: "INVENTORY.SURPLUS.DETECTED",
    LOW: "INVENTORY.LOW.DETECTED",
    RESERVED: "INVENTORY.RESERVED",
    DEDUCTED: "INVENTORY.DEDUCTED",
  },
  GARDEN: {
    HARVEST_WINDOW: "GARDEN.HARVEST.WINDOW",
    PLANTING_WINDOW: "GARDEN.PLANTING.WINDOW",
    PEST_RISK: "GARDEN.PEST.RISK",
  },
  WEATHER: {
    FROST_ALERT: "WEATHER.FROST.ALERT",
    HEAT_ALERT: "WEATHER.HEAT.ALERT",
    RAIN_WINDOW: "WEATHER.RAIN.WINDOW",
  },
  DAY: { MORNING: "DAY.MORNING", AFTERNOON: "DAY.AFTERNOON", EVENING: "DAY.EVENING" },
  SABBATH: { PREP: "SABBATH.PREP.WINDOW", START: "SABBATH.START", END: "SABBATH.END" },
};
let EVENTS = FALLBACK_EVENTS;

// Try to load shared events constant if you added it
(async () => {
  const mod = await safeImportMany([
    "@/ai/automation/events.js",
    "@/ai/automation/events/index.js",
    "@/ai/automation/events",
  ]);
  if (mod?.default || Object.keys(mod || {}).length) {
    EVENTS = (mod.default || mod);
  }
})();

/* ---------------------------------------
   Agent contract shim (keeps UX consistent)
----------------------------------------*/
function ensureAgentContract(agent, name = "agent") {
  const a = agent?.default || agent || {};
  if (typeof a.estimatePlan !== "function") {
    a.estimatePlan = async () => ({ summary: `${name}: no estimatePlan`, suggestions: [] });
    console.warn(`[${name}] missing estimatePlan(ctx, options) — using fallback`);
  }
  if (typeof a.generatePlan !== "function") {
    a.generatePlan = async () => ({ plan: [], emits: [] });
    console.warn(`[${name}] missing generatePlan(ctx, options) — using fallback`);
  }
  if (typeof a.handleCommand !== "function") {
    a.handleCommand = async () => ({ ok: false, note: `${name}: no handleCommand` });
  }
  return a;
}

/* ---------------------------------------
   Shared context (fallback-friendly)
----------------------------------------*/
async function getHouseholdContextSafe() {
  const mod = await safeImportMany([
    "@/ai/context/index.js",
    "@/ai/context.js",
    "@/ai/context",
  ]);
  if (typeof mod?.getHouseholdContext === "function") {
    return await mod.getHouseholdContext();
  }
  // Fallback: minimal context
  return {
    now: new Date(),
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    tod: getDaypart(),
    energy: "normal",
    zone: "7b",
    calendar: {},
    mealPlan: {},
    batchQueue: {},
    garden: {},
    storehouse: {},
    settings: {
      sabbath: { avoidSaturday: true },
    },
    utils: {},
  };
}

function getDaypart(d = new Date()) {
  const h = d.getHours();
  if (h < 12) return "morning";
  if (h < 17) return "afternoon";
  return "evening";
}

/* ---------------------------------------
   Build agents (dynamic, contract-wrapped)
----------------------------------------*/
async function buildAgents() {
  const [
    cookingRaw,
    cleaningRaw,
    gardeningRaw,
    gardenHarvestRaw,
    preservationRaw,
    mealPlanningRaw,
  ] = await Promise.all([
    safeImportMany(["@/agents/cookingAgent.js", "@/agents/cookingAgent"]),
    safeImportMany(["@/agents/cleaningAgent.js", "@/agents/cleaningAgent", "@/agents/cleaningRoutineAgent.js"]),
    safeImportMany(["@/agents/gardeningAgent.js", "@/agents/gardeningAgent"]),
    safeImportMany(["@/agents/gardenHarvestAgent.js", "@/agents/gardenHarvestAgent"]),
    safeImportMany(["@/agents/preservationAgent.js", "@/agents/preservationAgent"]),
    safeImportMany(["@/agents/mealPlanningAgent.js", "@/agents/mealPlanningAgent"]),
  ]);

  return {
    cooking:       ensureAgentContract(cookingRaw, "CookingAgent"),
    cleaning:      ensureAgentContract(cleaningRaw, "CleaningAgent"),
    gardening:     ensureAgentContract(gardeningRaw, "GardeningAgent"),
    gardenHarvest: ensureAgentContract(gardenHarvestRaw, "GardenHarvestAgent"),
    preservation:  ensureAgentContract(preservationRaw, "PreservationAgent"),
    mealPlanning:  ensureAgentContract(mealPlanningRaw, "MealPlanningAgent"),
  };
}

/* ---------------------------------------
   Playbooks (policy graph)
----------------------------------------*/
const FALLBACK_PLAYBOOKS = [
  {
    id: "pre-batch-cook-reset",
    when: ({ events, ctx }) =>
      events.includes(EVENTS.SESSION.PLANNED.COOKING) && ctx.tod !== "evening",
    then: async ({ agents, ctx }) => {
      const est = await agents.cleaning.estimatePlan(ctx, { preset: "kitchen-reset-10min" });
      return {
        nudge: {
          title: "Quick kitchen reset for smoother batch cooking later",
          message: est?.summary || "Clear counters, empty sink, stage tools (≈10 min).",
          actions: [{ id: "start-reset", label: "Start 10-min timer" }],
          priority: 0.82,
          next: EVENTS.SESSION.STARTED.CLEANING,
        },
      };
    },
  },
  {
    id: "harvest->preserve->meal",
    when: ({ events }) => events.includes(EVENTS.GARDEN.HARVEST_WINDOW),
    then: async ({ agents, ctx }) => {
      const harvest = await agents.gardenHarvest.estimatePlan(ctx, { window: "this-week" });
      const preserve = await agents.preservation.estimatePlan(ctx, { inputs: harvest?.surplus ?? [] });
      const meals = await agents.mealPlanning.estimatePlan(ctx, { prefer: harvest?.fresh ?? [] });

      return {
        nudge: {
          title: "Garden is ready — use it well",
          message: `Harvest: ${harvest?.summary || "window open"}. Preserve: ${preserve?.summary || "options ready"}. Meals: ${meals?.summary || "suggested from fresh picks"}.`,
          actions: [
            { id: "schedule-harvest", label: "Schedule harvest" },
            { id: "queue-preserve",   label: "Queue preservation" },
            { id: "add-meals",        label: "Add meals" },
          ],
          priority: 0.89,
          next: EVENTS.SESSION.PLANNED.GARDENING,
        },
      };
    },
  },
  {
    id: "sabbath-prep",
    when: ({ events, ctx }) => {
      const sab = ctx?.settings?.sabbath;
      return events.includes(EVENTS.SABBATH.PREP) && sab;
    },
    then: async ({ agents, ctx }) => {
      const cook = await agents.cooking.estimatePlan(ctx, { preset: "sabbath" });
      const clean = await agents.cleaning.estimatePlan(ctx, { preset: "high-visibility-rooms" });
      return {
        nudge: {
          title: "Shabbat prep flow",
          message: `${cook?.summary || "Plan & prep meals today."} ${clean?.summary || "Quick tidy and bathrooms."}`,
          actions: [{ id: "open-prep-checklist", label: "Open prep checklist" }],
          priority: 0.95,
          next: EVENTS.SESSION.PLANNED.COOKING,
        },
      };
    },
  },
];

let PLAYBOOKS = FALLBACK_PLAYBOOKS;

// Try to load your external playbooks if present
(async () => {
  const mod = await safeImportMany([
    "@/ai/automation/policies/household.playbooks.js",
    "@/ai/automation/policies/household.playbooks/index.js",
    "@/ai/automation/policies/household.playbooks",
  ]);
  if (Array.isArray(mod?.PLAYBOOKS)) PLAYBOOKS = mod.PLAYBOOKS;
})();

/* ---------------------------------------
   Nudge Presentation + Actions
----------------------------------------*/
function presentNudge(nudge, emit) {
  // Notify any UI listeners
  emit?.("automation/nudge", nudge);
  try {
    window.dispatchEvent?.(new CustomEvent("automation:nudge", { detail: nudge }));
  } catch {}

  // Minimal console breadcrumb for dev
  console.debug("[Orchestrator:Nudge]", nudge.title, nudge);
}

// Exported so buttons can call back into the app if you wire them
export async function handleNudgeAction(actionId, meta = {}) {
  try {
    const [{ TimerManager }, { ReminderManager }, socketMod] = await Promise.all([
      safeImportMany(["@/managers/TimerManager.js", "@/managers/TimerManager"]),
      safeImportMany(["@/managers/ReminderManager.js", "@/managers/ReminderManager"]),
      safeImportMany(["@/server/services/socket.js", "@/server/services/socket"]),
    ]);

    switch (actionId) {
      case "start-reset":
        TimerManager?.start?.({ label: "Kitchen reset", minutes: 10 });
        break;
      case "schedule-harvest":
        ReminderManager?.create?.({ title: "Harvest window", when: "next-available-morning" });
        break;
      case "queue-preserve":
        // Optionally call preservation agent generate
        break;
      case "add-meals":
        // Optionally call meal planning agent generate
        break;
      case "open-prep-checklist":
        socketMod?.socket?.emit?.("ui/open", { path: "/cooking", tab: "prep" });
        break;
      case "open-cleaning-checklist":
        socketMod?.socket?.emit?.("ui/open", { path: "/cleaning", tab: "today" });
        break;
      case "add-to-shopping-list":
        // Hook your shopping list service if present
        break;
      default:
        break;
    }
  } catch (e) {
    console.warn("[handleNudgeAction] error:", e?.message || e);
  }
}

/* ---------------------------------------
   Cooking triggers → Nudges
   (integrates detectCookingTriggers.js from this project)
----------------------------------------*/
function mapCookingTriggersToNudges(triggers = [], settings = {}) {
  const avoidSaturday = settings?.sabbath?.avoidSaturday !== false;
  const nudges = [];

  for (const t of triggers) {
    const base = { priority: 0.7, actions: [] };
    switch (t.type) {
      case "CALENDAR_SYNC":
        nudges.push({
          title: "Approval granted — syncing your plan",
          message: t.reason || "Updating calendar with the latest tasks and sessions.",
          priority: 0.92,
          actions: [],
        });
        break;

      case "ACK_APPROVAL":
        nudges.push({
          title: "Approved ✅",
          message: t.reason || "We’ll handle the next steps for you.",
          priority: 0.8,
          actions: [],
        });
        break;

      case "SHOW_TODAY_MEALS":
        nudges.push({
          title: "Today’s meals",
          message: "Here’s what’s planned. Need to swap anything?",
          priority: 0.75,
          actions: [{ id: "open-prep-checklist", label: "Open prep" }],
        });
        break;

      case "OPEN_RECIPE":
        nudges.push({
          title: "Ready to cook?",
          message: "Opening your recipe with timers and steps.",
          priority: 0.8,
          actions: [{ id: "open-prep-checklist", label: "Open recipe" }],
        });
        break;

      case "PREHEAT_APPLIANCE":
        nudges.push({
          title: "Preheat now",
          message: t.reason || "It’s time to preheat so you’re not waiting later.",
          priority: 0.9,
          actions: [{ id: "open-prep-checklist", label: "Prep steps" }],
        });
        break;

      case "THAW_REMINDER":
        if (!avoidSaturday || new Date().getDay() !== 6) {
          nudges.push({
            title: "Start thawing",
            message: t.reason || "Move frozen items to the fridge so they’re ready.",
            priority: 0.86,
            actions: [{ id: "open-prep-checklist", label: "See plan" }],
          });
        }
        break;

      case "SHOW_COOKING_CHECKLIST":
        nudges.push({
          title: "Cooking checklist",
          message: "Here’s your short checklist before cooking.",
          priority: 0.7,
          actions: [{ id: "open-prep-checklist", label: "Open checklist" }],
        });
        break;

      case "NOTIFY_PREHEAT_DONE":
      case "NOTIFY_TEMP_TARGET":
        nudges.push({
          title: t.type === "NOTIFY_PREHEAT_DONE" ? "Oven preheated" : "Target temp reached",
          message: t.reason || "You can move to the next step now.",
          priority: 0.88,
          actions: [{ id: "open-prep-checklist", label: "Next step" }],
        });
        break;

      case "START_PREP_ON_ARRIVAL":
        nudges.push({
          title: "Welcome home — let’s get a head start",
          message: t.reason || "You’ve got a meal coming up; want to start prep?",
          priority: 0.9,
          actions: [{ id: "open-prep-checklist", label: "Start prep" }],
        });
        break;

      case "TIMER_ELAPSED":
        nudges.push({
          title: "Timer finished",
          message: t.reason || "Step completed.",
          priority: 0.93,
          actions: [{ id: "open-prep-checklist", label: "Next step" }],
        });
        break;

      default:
        nudges.push({
          title: "Kitchen update",
          message: t.reason || "You have a recommended action.",
          ...base,
        });
    }
  }

  return nudges;
}

/* ---------------------------------------
   Cleaning triggers → Nudges (existing)
----------------------------------------*/
function mapCleaningTriggersToNudges(trigs, settings) {
  const avoidSaturday = settings?.sabbath?.avoidSaturday !== false;
  const nudges = [];

  (trigs?.triggers || []).forEach((t) => {
    if (t.type === "SUPPLY_LOW") {
      nudges.push({
        title: "Cleaning supply running low",
        message: t.message,
        priority: t.severity === "high" ? 0.92 : t.severity === "medium" ? 0.78 : 0.6,
        actions: [
          { id: "add-to-shopping-list", label: "Add to shopping list", meta: { item: t?.meta?.name || t.key } },
        ],
        suggestedWindows: t.suggestedWindows?.filter(w => {
          if (!avoidSaturday) return true;
          const d = new Date(w.startISO);
          return d.getDay() !== 6; // skip Saturday
        }),
      });
    }
    if (t.type === "SUPPLY_OVERDUE") {
      nudges.push({
        title: "Confirm or update cleaning supply",
        message: t.message,
        priority: 0.55,
        actions: [{ id: "open-cleaning-checklist", label: "Open cleaning dashboard" }],
      });
    }
    if (t.type === "ZONE_OVERDUE") {
      nudges.push({
        title: `Cleaning due: ${t.key.split(":")[1]}`,
        message: t.message,
        priority: t.severity === "high" ? 0.9 : t.severity === "medium" ? 0.75 : 0.6,
        actions: [
          { id: "open-cleaning-checklist", label: "Open checklist" },
        ],
        suggestedWindows: t.suggestedWindows,
      });
    }
  });

  // Back-compat summary nudges
  if ((trigs?.restockNeeded || []).length) {
    nudges.push({
      title: "Restock cleaning supplies",
      message: `Low: ${(trigs.restockNeeded).join(", ")}`,
      priority: 0.8,
      actions: [{ id: "add-to-shopping-list", label: "Add all to list" }],
    });
  }
  if ((trigs?.zonesDue || []).length) {
    nudges.push({
      title: "Zones overdue",
      message: `Needs attention: ${trigs.zonesDue.join(", ")}`,
      priority: 0.7,
      actions: [{ id: "open-cleaning-checklist", label: "Open checklist" } ],
    });
  }

  return nudges;
}

/* ---------------------------------------
   Orchestrator core
----------------------------------------*/
const recentEvents = new Set();
const BURST_DELAY_MS = 300;

async function evaluatePlaybooks(eventNames, maxNudges = 2) {
  const ctx = await getHouseholdContextSafe();
  const agents = await buildAgents();

  const matches = [];
  for (const pb of PLAYBOOKS) {
    try {
      if (await pb.when({ events: eventNames, ctx })) {
        const res = await pb.then({ agents, ctx });
        if (res?.nudge) matches.push(res.nudge);
      }
    } catch (err) {
      console.warn("[householdOrchestrator] playbook error", pb?.id, err);
    }
  }

  matches.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  return matches.slice(0, maxNudges);
}

/* ---------------------------------------
   Default export: wire to your app bus
----------------------------------------*/
export default function householdOrchestrator({ ctx, emit, options = {} }) {
  const MAX_NUDGES = Number(options?.maxNudges || 2);

  // Debounced flush of recent events -> nudges (policy graph)
  const flush = async () => {
    const events = [...recentEvents];
    recentEvents.clear();

    const nudges = await evaluatePlaybooks(events, MAX_NUDGES);
    nudges.forEach((n) => presentNudge(n, emit));
  };

  const queue = () => {
    clearTimeout(queue._t);
    queue._t = setTimeout(flush, BURST_DELAY_MS);
  };

  const emitEvent = (eventName) => {
    recentEvents.add(eventName);
    queue();
  };

  // NEW: dynamic cooking detector pipeline (integrates your detectCookingTriggers)
  const routeThroughCookingDetector = async (domainEvent) => {
    try {
      const mod = await safeImportMany([
        "@/services/triggers/detectCookingTriggers.js",
        "@/services/triggers/detectCookingTriggers",
        "./detectCookingTriggers.js",
      ]);
      const detect = mod?.default || mod?.detectCookingTriggers;
      if (typeof detect !== "function") return;

      const ctxSnap = await getHouseholdContextSafe();

      // Shape the envelope expected by detectCookingTriggers
      // domainEvent: { type: string, payload: any, meta?: { tz?, at? } }
      const { type, payload, meta = {} } = domainEvent || {};
      const kind = inferKindFromType(type, payload);
      const envelope = {
        kind,
        subkind: inferSubkind(kind, payload),
        id: payload?.id || payload?.eventId || type,
        at: meta.at || new Date().toISOString(),
        payload: payload || {},
      };

      const trigs = detect(envelope, {
        tz: ctxSnap?.tz || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
        user: { dietaryTags: ctxSnap?.user?.dietaryTags || [], appliancePrefs: ctxSnap?.user?.appliancePrefs || [] },
        config: {}, // allow global overrides here later
        services: {
          calendar: ctxSnap?.calendar?.service,
          parse: await safeImportMany([
            "@/services/planning/parseRecipeSteps.js",
            "@/services/planning/parseRecipeSteps",
          ]).then(m => m?.default || m),
        }
      });

      if (Array.isArray(trigs) && trigs.length) {
        const nudges = mapCookingTriggersToNudges(trigs, ctxSnap?.settings || {});
        // De-dupe within this pass by title+message
        const seen = new Set();
        for (const n of nudges) {
          const key = `${n.title}::${n.message}`;
          if (seen.has(key)) continue;
          seen.add(key);
          presentNudge(n, emit);
        }
      }
    } catch (e) {
      console.warn("[householdOrchestrator] cooking detector error:", e?.message || e);
    }
  };

  // NEW: periodic detectors → nudges (cleaning/inventory/etc.)
  let intervalId = null;
  let daypartTimer = null;

  const runDetectors = async () => {
    try {
      const ctxSnap = await getHouseholdContextSafe();

      // Cleaning detector
      const cleaningDet = await safeImportMany([
        "@/services/triggers/detectCleaningTriggers.js",
        "@/services/triggers/detectCleaningTriggers",
        "./detectCleaningTriggers.js",
      ]);

      if (typeof cleaningDet?.default === "function") {
        const trig = await cleaningDet.default({
          now: new Date(),
          avoidSabbath: ctxSnap?.settings?.sabbath?.avoidSaturday !== false,
          sabbathOnSaturday: true,
        });

        const nudges = mapCleaningTriggersToNudges(trig, ctxSnap.settings);
        // De-dupe by title+message within this pass
        const seen = new Set();
        nudges.forEach((n) => {
          const key = `${n.title}::${n.message}`;
          if (seen.has(key)) return;
          seen.add(key);
          presentNudge(n, emit);
        });
      }

      // TODO: add inventory/garden detectors similarly (when those services are ready)

    } catch (e) {
      console.warn("[householdOrchestrator] detector error:", e?.message || e);
    }
  };

  // Tick every 30 minutes by default (configurable)
  const POLL_MS = Number(options?.pollMs) || 30 * 60 * 1000;
  intervalId = setInterval(runDetectors, POLL_MS);

  // Emit daypart transitions (MORNING/AFTERNOON/EVENING) for playbooks
  const scheduleDaypartEvents = () => {
    if (daypartTimer) clearTimeout(daypartTimer);

    const now = new Date();
    const dayparts = [
      { name: EVENTS.DAY.MORNING,   h: 8 },
      { name: EVENTS.DAY.AFTERNOON, h: 13 },
      { name: EVENTS.DAY.EVENING,   h: 18 },
    ];
    // Find next event today or tomorrow
    let next = null;
    for (const dp of dayparts) {
      const t = new Date(now.getFullYear(), now.getMonth(), now.getDate(), dp.h, 0, 0, 0);
      if (t > now) { next = { when: t, name: dp.name }; break; }
    }
    if (!next) {
      const t = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 8, 0, 0, 0);
      next = { when: t, name: EVENTS.DAY.MORNING };
    }

    const ms = next.when.getTime() - now.getTime();
    daypartTimer = setTimeout(() => {
      emitEvent(next.name);
      scheduleDaypartEvents(); // reschedule for the following transition
    }, Math.max(1000, ms));
  };
  scheduleDaypartEvents();

  // Initial run to surface immediate triggers on boot
  runDetectors().catch(() => {});

  // Keep your existing logic AND raise higher-level events for intuition
  const onEvent = async ({ type, payload, meta }) => {
    try {
      // Route any domain event through the cooking detector first (it is cross-domain aware)
      await routeThroughCookingDetector({ type, payload, meta });

      // Translate low-level signals to high-level playbook events
      if (type === "vision/saved") {
        const { vision, when = new Date().toISOString() } = payload || {};

        // Garden plan from vision
        try {
          const garden = await safeImportMany(["@/agents/gardeningAgent.js", "@/agents/gardeningAgent"]);
          await garden?.default?.handleCommand?.("planFromVision", {
            vision, month: new Date().getMonth() + 1,
          });
        } catch {}

        // Animals plan from vision
        try {
          const animals = await safeImportMany(["@/agents/animalAgent.js", "@/agents/animalAgent"]);
          await animals?.default?.handleCommand?.("planFromVision", { vision });
        } catch {}

        // Cleaning routine from vision time budget
        try {
          const cleaning = await safeImportMany(["@/agents/cleaningAgent.js", "@/agents/cleaningAgent", "@/agents/cleaningRoutineAgent.js"]);
          await cleaning?.default?.handleCommand?.("buildRoutine", {
            rooms: ["Kitchen","Bath","Entry","Living"], // starter
            duration: Math.max(30, Number(vision?.weeklyHours || 0) * 6), // heuristic
            intensity: vision?.profileKey === "agrarian-offgrid" ? "deep" : "standard",
          });
        } catch {}

        // Persist a household snapshot / notify UI
        emit?.("household/planUpdated", { when, from: "vision" });
        try {
          window.dispatchEvent?.(new CustomEvent("household:planUpdated", { detail: { when } }));
        } catch {}

        // Intuition: this often implies future cooking/cleaning sessions
        emitEvent(EVENTS.SESSION.PLANNED.COOKING);
        emitEvent(EVENTS.SESSION.PLANNED.CLEANING);
      }

      if (type === "recipes/consolidated") {
        const { recipes, merged, session, visionKey } = payload || {};

        // Update inventory requirements
        try {
          const inv = await safeImportMany(["@/agents/inventoryAgent.js", "@/agents/inventoryAgent"]);
          await inv?.default?.handleCommand?.("syncRequirements", {
            required: merged?.items, source: "recipeConsolidator",
          });
        } catch {}

        // Build batch cooking session (timers/labels handled inside template)
        try {
          const batch = await safeImportMany([
            "@/services/templates/batchSessionBuilder.js",
            "@/services/templates/batchSessionBuilder",
          ]);
          await batch?.execute?.(
            { inventorySnapshot: {}, applianceAvail: {} },
            { now: new Date() }
          );
        } catch {}

        // If agrarian/hybrid, request garden & animals to cover gaps
        if (/(agrarian|hybrid)/i.test(String(visionKey || ""))) {
          try {
            const garden = await safeImportMany(["@/agents/gardeningAgent.js", "@/agents/gardeningAgent"]);
            await garden?.default?.handleCommand?.("cropNeedsFromRecipes", { items: merged?.items || [] });
          } catch {}
          try {
            const animals = await safeImportMany(["@/agents/animalAgent.js", "@/agents/animalAgent"]);
            await animals?.default?.handleCommand?.("proteinPlanFromRecipes", { items: merged?.items || [] });
          } catch {}
        }

        emit?.("household/planUpdated", { from: "recipes", count: recipes?.length || 0 });
        try {
          window.dispatchEvent?.(new CustomEvent("household:planUpdated", {
            detail: { from: "recipes", count: recipes?.length || 0 }
          }));
        } catch {}

        // Intuition: consolidated recipes usually mean a planned cooking session
        emitEvent(EVENTS.SESSION.PLANNED.COOKING);
      }

      // Generic approval → high-level event (cooking/cleaning/animal/gardening/inventory)
      if (type === "approval/statusChanged") {
        const domain = String(payload?.domain || "").toLowerCase();
        const status = String(payload?.status || "").toLowerCase();
        emitEvent(EVENTS.APPROVAL.RECEIVED);
        if (status === "approved") {
          emitEvent(EVENTS.APPROVAL.APPROVED);
          if (["cooking","cleaning","gardening"].includes(domain)) {
            emitEvent(EVENTS.SESSION.PLANNED[domain.toUpperCase()]);
          }
        } else if (status === "rejected") {
          emitEvent(EVENTS.APPROVAL.REJECTED);
        }
      }

      // Bubble certain direct signals to playbooks:
      if (type === "garden/harvestWindow") emitEvent(EVENTS.GARDEN.HARVEST_WINDOW);
      if (type === "weather/frostAlert")   emitEvent(EVENTS.WEATHER.FROST_ALERT);
      if (type === "sabbath/prep")         emitEvent(EVENTS.SABBATH.PREP);

    } catch (e) {
      console.warn("[householdOrchestrator] error:", e?.message || e);
    }
  };

  // Wire listeners from app context bus
  ctx?.on?.("event", onEvent);

  // Debounce queue controller
  const queueCtl = () => {
    clearTimeout(queueCtl._t);
    queueCtl._t = setTimeout(async () => {
      const events = [...recentEvents];
      recentEvents.clear();
      const nudges = await evaluatePlaybooks(events, MAX_NUDGES);
      nudges.forEach((n) => presentNudge(n, emit));
    }, BURST_DELAY_MS);
  };

  // Expose a minimal API on the returned disposer if needed later
  const api = {
    emitEvent,
    onEvent,
  };

  // Cleanup
  return () => {
    ctx?.off?.("event", onEvent);
    clearTimeout(queue._t);
    clearTimeout(queueCtl._t);
    clearInterval(intervalId);
    clearTimeout(daypartTimer);
    // return API for testing convenience
    return api;
  };
}

/* ---------------------------------------
   Helpers
----------------------------------------*/
function inferKindFromType(type = "", payload) {
  const t = String(type).toLowerCase();
  if (t.startsWith("chat/")) return "chat";
  if (t.startsWith("approval/")) return "approval";
  if (t.startsWith("inventory/")) return "inventory";
  if (t.startsWith("calendar/")) return "calendar";
  if (t.startsWith("device/")) return "device";
  if (t.startsWith("location/")) return "location";
  if (t.startsWith("timer/")) return "timer";
  // Heuristics if upstream didn’t namespace types
  if (payload?.text) return "chat";
  if (payload?.status && payload?.domain) return "approval";
  return "chat";
}
function inferSubkind(kind, payload) {
  if (kind === "chat") return "text";
  if (kind === "approval") return "status";
  if (kind === "device") return String(payload?.code || "sensor");
  return undefined;
}
