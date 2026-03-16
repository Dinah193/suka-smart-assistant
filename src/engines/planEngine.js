// C:\Users\larho\suka-smart-assistant\src\engines\planEngine.js

/**
 * planEngine
 * ----------
 * Purpose:
 *  - Create actionable daily/weekly plans from household context (calendar availability,
 *    inventory, weather, preferences, imports).
 *  - Invoke domain micro-planners (cooking/cleaning/garden/animal/preservation/storehouse),
 *    merge their outputs, and emit session creation + schedule requests.
 *  - Re-plan when upstream signals change (inventory updated, harvest logged, imports parsed).
 *  - Optionally export anonymized planning summaries to the Hub (familyFundMode).
 *
 * Pipeline fit (imports → intelligence → automation → (optional) hub export):
 *  - imports: recipes/meals/cleaning checklists/garden seeds/animal tasks/video-how-to
 *  - intelligence: this engine computes near-term plans per domain
 *  - automation: emits *.session.created + automation.schedule.request for each session
 *  - hub export: sends plan summaries without blocking core flow
 *
 * Contract notes:
 *  - All events emitted use shape: { type, ts, source, data } with ISO timestamps.
 *  - Session objects follow SSA’s session contract keys (id, title, domain, schedule, meta, session).
 *  - Engine degrades gracefully if specific services/planners are unavailable.
 */

//// Soft/defensive dynamic import /////////////////////////////////////////////

async function softImport(path) {
  try {
    return await import(path);
  } catch {
    return null;
  }
}

//// Dependencies //////////////////////////////////////////////////////////////

let eventBus; // required
let featureFlags = { familyFundMode: false };

let HouseholdPrefs; // optional
let CalendarService; // optional (for availability)
let InventoryService; // optional (for constraints)
let WeatherService; // optional (outdoor planning)
let SessionStore; // optional (dedupe sessions)
let GoalStore; // optional (household goals: tidy score, protein targets, etc.)

// Domain micro-planners (all optional, loaded at start)
// Expected planner signature:
//   plan({ horizon, ctx, hints }) -> Promise<{ sessions: Session[], notes?: string[] }>
let CookingPlanner;
let CleaningPlanner;
let GardenPlanner;
let AnimalPlanner;
let PreservationPlanner;
let StorehousePlanner;

let HubPacketFormatter; // optional
let FamilyFundConnector; // optional

//// Utilities /////////////////////////////////////////////////////////////////

const nowISO = () => new Date().toISOString();

function safeId(prefix = "plan") {
  if (typeof crypto !== "undefined" && crypto.randomUUID)
    return `${prefix}_${crypto.randomUUID()}`;
  return `${prefix}_${Math.random().toString(36).slice(2)}_${Date.now()}`;
}

function emit(type, source, data) {
  if (!eventBus?.emit) return;
  eventBus.emit({ type, ts: nowISO(), source, data });
}

function sanitize(x) {
  try {
    return JSON.parse(JSON.stringify(x));
  } catch {
    return undefined;
  }
}
function safeError(err) {
  return { name: err?.name || "Error", message: err?.message || String(err) };
}
function clamp01(x) {
  return Math.max(0, Math.min(1, Number(x) || 0));
}

async function exportToHubIfEnabled(payload) {
  try {
    if (!featureFlags?.familyFundMode) return;
    const pkt = HubPacketFormatter?.format?.(payload, { stream: "planEngine" });
    if (!pkt) return;
    await FamilyFundConnector?.send?.(pkt);
  } catch {
    // silently ignore hub errors
  }
}

//// Engine state //////////////////////////////////////////////////////////////

const state = {
  initialized: false,
  planning: false,
  dirty: false,
  queue: [],
  lastPlanSummary: null,
  config: {
    // Planning horizon
    defaultHorizon: {
      // relative window; exact windows derived from CalendarService if present
      days: 1, // daily default
      includeToday: true,
    },
    weeklyHorizonDays: 7,
    // Scheduling hints
    autoSchedule: true, // emit automation.schedule.request for created sessions
    // Dedupe policy
    dedupeKey: (s) =>
      `${s.domain}:${
        s.meta?.linkedHarvestId || s.meta?.recipeId || s.title || s.id
      }`,
    // Guard hints (actual guard enforcement handled by other engines/runtimes)
    preferIndoorWhenBadWeather: true,
    // Output shaping
    perDomainSessionLimit: 6,
  },
};

let debounceTimer = null;

//// Context builder ///////////////////////////////////////////////////////////

/**
 * Build planning context from prefs, calendar availability, inventory, weather, goals.
 */
async function buildPlanningContext(horizon) {
  const now = new Date();

  const prefs =
    (HouseholdPrefs?.get?.() || HouseholdPrefs?.getCached?.()) ?? {};
  const goals = GoalStore?.get?.() ?? null;

  let availability = [];
  if (CalendarService?.getAvailabilityWindows) {
    try {
      availability = await CalendarService.getAvailabilityWindows({
        days: horizon?.days ?? state.config.defaultHorizon.days,
        includeToday:
          horizon?.includeToday ?? state.config.defaultHorizon.includeToday,
      });
    } catch {
      /* noop */
    }
  }

  let inventorySnapshot = null;
  if (InventoryService?.snapshot) {
    try {
      inventorySnapshot = await InventoryService.snapshot();
    } catch {
      /* noop */
    }
  }

  let weather = null;
  if (WeatherService?.getSnapshot) {
    try {
      weather = await WeatherService.getSnapshot();
    } catch {
      /* noop */
    }
  }

  return {
    now,
    prefs,
    goals,
    calendar: { availability },
    inventory: inventorySnapshot,
    weather,
  };
}

//// Planner adapter & fallbacks //////////////////////////////////////////////

/**
 * Adapter that calls a domain planner if available, else uses a fallback heuristic.
 */
async function planDomain(domain, horizon, ctx, hints) {
  const planner = {
    cooking: CookingPlanner,
    cleaning: CleaningPlanner,
    garden: GardenPlanner,
    animal: AnimalPlanner,
    preservation: PreservationPlanner,
    storehouse: StorehousePlanner,
  }[domain];

  try {
    if (planner?.plan) {
      return await planner.plan({ horizon, ctx, hints });
    }
  } catch (err) {
    emit("engine.warning", "engines/planEngine", {
      message: `Planner failure for ${domain}`,
      error: safeError(err),
    });
  }

  // Fallback heuristic: create a lightweight placeholder session to unblock flows
  const session = fallbackSession(domain, ctx);
  return { sessions: session ? [session] : [], notes: [`fallback_${domain}`] };
}

function fallbackSession(domain, ctx) {
  // Minimal heuristic per domain; real logic delegated to micro-planners.
  const base = {
    id: safeId("session"),
    domain,
    source: "engines/planEngine",
    createdAt: nowISO(),
    schedule: buildWindowFromAvailability(ctx, 30),
    meta: {},
    session: { anchors: [], tasks: [] },
  };

  switch (domain) {
    case "cooking":
      return {
        ...base,
        title: "Quick Pantry Meal",
        session: {
          anchors: [{ type: "meal", label: "dinner", weight: 0.8 }],
          tasks: [
            {
              id: safeId("task"),
              type: "prep",
              title: "Check pantry",
              estimatedMinutes: 5,
            },
            {
              id: safeId("task"),
              type: "cook",
              title: "One-pan meal",
              estimatedMinutes: 20,
            },
          ],
        },
      };
    case "cleaning":
      return {
        ...base,
        title: "15-min Reset (High-traffic room)",
        session: {
          anchors: [{ type: "routine", label: "reset", weight: 0.7 }],
          tasks: [
            {
              id: safeId("task"),
              type: "tidy",
              title: "Surfaces & floors",
              estimatedMinutes: 15,
              meta: { noisy: true },
            },
          ],
        },
        meta: { noisy: true },
      };
    case "garden":
      return {
        ...base,
        title: "Water & Visual Inspect",
        meta: { outdoor: true },
        session: {
          anchors: [{ type: "task", label: "water", weight: 0.7 }],
          tasks: [
            {
              id: safeId("task"),
              type: "water",
              title: "Water beds/containers",
              estimatedMinutes: 10,
            },
            {
              id: safeId("task"),
              type: "inspect",
              title: "Inspect pests/disease",
              estimatedMinutes: 10,
            },
          ],
        },
      };
    case "animal":
      return {
        ...base,
        title: "Feed & Check",
        session: {
          anchors: [{ type: "task", label: "animal-care", weight: 0.8 }],
          tasks: [
            {
              id: safeId("task"),
              type: "feed",
              title: "Feed livestock/poultry",
              estimatedMinutes: 10,
            },
            {
              id: safeId("task"),
              type: "check",
              title: "Water & health check",
              estimatedMinutes: 10,
            },
          ],
        },
      };
    case "preservation":
      return {
        ...base,
        title: "Quick Preserve (Freeze/Dehydrate)",
        session: {
          anchors: [{ type: "task", label: "preserve", weight: 0.7 }],
          tasks: [
            {
              id: safeId("task"),
              type: "prep",
              title: "Prep produce",
              estimatedMinutes: 10,
            },
            {
              id: safeId("task"),
              type: "preserve",
              title: "Freeze or dehydrate",
              estimatedMinutes: 20,
            },
          ],
        },
      };
    case "storehouse":
      return {
        ...base,
        title: "Inventory Spot-Check",
        session: {
          anchors: [{ type: "task", label: "inventory", weight: 0.6 }],
          tasks: [
            {
              id: safeId("task"),
              type: "audit",
              title: "Audit top 10 items",
              estimatedMinutes: 15,
            },
          ],
        },
      };
    default:
      return null;
  }
}

function buildWindowFromAvailability(ctx, minutes = 30) {
  const now = new Date();
  const from = now.toISOString();
  const to = new Date(now.getTime() + minutes * 60000).toISOString();

  const avail = Array.isArray(ctx?.calendar?.availability)
    ? ctx.calendar.availability
    : [];
  if (avail.length) {
    // Take the first upcoming window; otherwise fallback
    const first = avail.find((w) => new Date(w.to) > now) || avail[0];
    if (first) return { from: first.from, to: first.to };
  }
  return { from, to };
}

//// Dedupe & trim helpers /////////////////////////////////////////////////////

function dedupeSessions(sessions, keyFn) {
  const seen = new Set();
  const out = [];
  for (const s of sessions) {
    const k = keyFn(s);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(s);
    }
  }
  return out;
}

function limitPerDomain(sessions, limit) {
  const counts = new Map();
  return sessions.filter((s) => {
    const d = s.domain || "unknown";
    const n = counts.get(d) || 0;
    if (n >= limit) return false;
    counts.set(d, n + 1);
    return true;
  });
}

//// Core planning /////////////////////////////////////////////////////////////

async function computePlan({ horizon, domains, hints } = {}) {
  const h = normalizeHorizon(horizon);
  const ctx = await buildPlanningContext(h);

  // Weather hint for outdoor planning
  if (state.config.preferIndoorWhenBadWeather && ctx?.weather && hints) {
    hints.preferIndoor = ctx.weather?.outdoorOk === false;
  }

  const targetDomains =
    domains && domains.length
      ? domains
      : [
          "cooking",
          "cleaning",
          "garden",
          "animal",
          "preservation",
          "storehouse",
        ];

  const results = await Promise.all(
    targetDomains.map(async (d) => {
      const r = await planDomain(d, h, ctx, hints);
      return { domain: d, ...(r || { sessions: [], notes: [] }) };
    })
  );

  let sessions = results.flatMap((r) => r.sessions || []);
  sessions = sessions.map((s) => ({
    ...s,
    id: s.id || safeId("session"),
    source: s.source || "engines/planEngine",
    createdAt: s.createdAt || nowISO(),
    schedule: s.schedule || buildWindowFromAvailability(ctx),
  }));

  // Dedupe & limit per domain to avoid flooding UI/runtime
  sessions = dedupeSessions(sessions, state.config.dedupeKey);
  sessions = limitPerDomain(sessions, state.config.perDomainSessionLimit);

  // Optional: consult SessionStore to avoid re-creating identical sessions
  if (SessionStore?.existsLike) {
    const filtered = [];
    for (const s of sessions) {
      // eslint-disable-next-line no-await-in-loop
      const exists = await SessionStore.existsLike(state.config.dedupeKey(s));
      if (!exists) filtered.push(s);
    }
    sessions = filtered;
  }

  // Emit creation + (optional) schedule requests
  for (const s of sessions) {
    emit(`${s.domain}.session.created`, "engines/planEngine", {
      session: sanitize(s),
    });

    if (state.config.autoSchedule) {
      emit("automation.schedule.request", "engines/planEngine", {
        domain: s.domain,
        reason: "plan_engine",
        sessionId: s.id,
        preferredWindow: s?.schedule?.window || s.schedule,
        priority: domainPriority(s.domain),
      });
    }
  }

  const summary = {
    id: safeId("plan"),
    generatedAt: nowISO(),
    horizon: h,
    counts: summarizeCounts(sessions),
    notes: results.flatMap((r) => r.notes || []),
  };

  // Emit plan.created summary for UI/analytics
  emit("plan.created", "engines/planEngine", { summary: sanitize(summary) });

  // Optional hub export
  exportToHubIfEnabled({
    domain: "planning",
    action: "plan_created",
    payload: {
      horizon: summary.horizon,
      counts: summary.counts,
    },
  });

  state.lastPlanSummary = summary;
  return { sessions, summary };
}

function normalizeHorizon(h) {
  const days = Number(h?.days ?? state.config.defaultHorizon.days);
  const includeToday = !!(
    h?.includeToday ?? state.config.defaultHorizon.includeToday
  );
  return { days: Math.max(1, days), includeToday };
}

function summarizeCounts(sessions) {
  const counts = {};
  for (const s of sessions) {
    const d = s.domain || "unknown";
    counts[d] = (counts[d] || 0) + 1;
  }
  return counts;
}

function domainPriority(domain) {
  switch (domain) {
    case "cooking":
      return "high";
    case "animal":
      return "high";
    case "garden":
      return "medium";
    case "preservation":
      return "medium";
    case "cleaning":
      return "low";
    case "storehouse":
      return "low";
    default:
      return "low";
  }
}

//// Reactive planning (event-driven) //////////////////////////////////////////

function markDirtyAndDebounce() {
  state.dirty = true;
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    if (!state.planning) planSoon();
  }, 250);
}

async function planSoon() {
  if (state.planning) return;
  state.planning = true;
  try {
    await computePlan();
    state.dirty = false;
  } catch (err) {
    emit("engine.warning", "engines/planEngine", {
      message: "auto-plan failed",
      error: safeError(err),
    });
  } finally {
    state.planning = false;
  }
}

//// Public API ////////////////////////////////////////////////////////////////

/**
 * start(config)
 *  - Loads dependencies and optional domain planners
 *  - Subscribes to signals that should trigger re-planning:
 *      • inventory.updated / inventory.shortage.detected
 *      • garden.harvest.logged / preservation.completed
 *      • import.parsed (any domain)
 *      • cooking.session.created (for meal cadence) and execution signals
 *  - Emits engine.started and generates an initial day plan
 */
export async function start(config = {}) {
  if (state.initialized) return;

  state.config = { ...state.config, ...config };

  const [
    evb,
    ff,
    prefs,
    cal,
    inv,
    weather,
    sess,
    goals,

    // Planners (soft)
    cookP,
    cleanP,
    gardenP,
    animalP,
    preserveP,
    storeP,

    hubFmt,
    hubConn,
  ] = await Promise.all([
    softImport("../services/events/eventBus.js"),
    softImport("@/config/featureFlags.json"),
    softImport("../services/HouseholdPrefs.js"),
    softImport("../services/CalendarService.js"),
    softImport("../domain/inventory/InventoryService.js"),
    softImport("../services/WeatherService.js"),
    softImport("../stores/SessionStore.js"),
    softImport("../stores/GoalStore.js"),

    softImport("./planners/cookingPlanner.js"),
    softImport("./planners/cleaningPlanner.js"),
    softImport("./planners/gardenPlanner.js"),
    softImport("./planners/animalPlanner.js"),
    softImport("./planners/preservationPlanner.js"),
    softImport("./planners/storehousePlanner.js"),

    softImport("@/services/hub/HubPacketFormatter.js"),
    softImport("@/services/hub/FamilyFundConnector.js"),
  ]);

  eventBus = evb?.default || evb || eventBus;
  featureFlags = ff?.default || ff || featureFlags;
  HouseholdPrefs = prefs?.default || prefs || HouseholdPrefs;
  CalendarService = cal?.default || cal || CalendarService;
  InventoryService = inv?.default || inv || InventoryService;
  WeatherService = weather?.default || weather || WeatherService;
  SessionStore = sess?.default || sess || SessionStore;
  GoalStore = goals?.default || goals || GoalStore;

  CookingPlanner = cookP?.default || cookP || null;
  CleaningPlanner = cleanP?.default || cleanP || null;
  GardenPlanner = gardenP?.default || gardenP || null;
  AnimalPlanner = animalP?.default || animalP || null;
  PreservationPlanner = preserveP?.default || preserveP || null;
  StorehousePlanner = storeP?.default || storeP || null;

  HubPacketFormatter = hubFmt?.default || hubFmt || HubPacketFormatter;
  FamilyFundConnector = hubConn?.default || hubConn || FamilyFundConnector;

  if (!eventBus?.on || !eventBus?.emit) {
    throw new Error("planEngine requires a functional eventBus with on/emit.");
  }

  // React to key signals
  eventBus.on("inventory.updated", markDirtyAndDebounce);
  eventBus.on("inventory.shortage.detected", markDirtyAndDebounce);
  eventBus.on("garden.harvest.logged", markDirtyAndDebounce);
  eventBus.on("preservation.completed", markDirtyAndDebounce);

  // Any import likely changes plan opportunities
  eventBus.on("import.parsed", markDirtyAndDebounce);

  // Session lifecycle touches cadence; re-plan after new sessions or executions
  const domains = [
    "cooking",
    "cleaning",
    "garden",
    "animal",
    "preservation",
    "storehouse",
  ];
  domains.forEach((d) => {
    eventBus.on(`${d}.session.created`, markDirtyAndDebounce);
    eventBus.on(`${d}.session.updated`, markDirtyAndDebounce);
    eventBus.on(`${d}.session.executed`, markDirtyAndDebounce);
  });

  state.initialized = true;

  emit("engine.started", "engines/planEngine", {
    config: sanitize(state.config),
    degraded: {
      calendar: !CalendarService,
      inventory: !InventoryService,
      weather: !WeatherService,
      cookingPlanner: !CookingPlanner,
      cleaningPlanner: !CleaningPlanner,
      gardenPlanner: !GardenPlanner,
      animalPlanner: !AnimalPlanner,
      preservationPlanner: !PreservationPlanner,
      storehousePlanner: !StorehousePlanner,
    },
  });

  // Initial day plan
  markDirtyAndDebounce();
}

/**
 * planDay(hints?)
 *  - Manual API: generate a plan for today with optional hints.
 */
export async function planDay(hints = {}) {
  if (!state.initialized) await start();
  return computePlan({ horizon: { days: 1, includeToday: true }, hints });
}

/**
 * planWeek(hints?)
 *  - Manual API: generate a plan for the next 7 days.
 */
export async function planWeek(hints = {}) {
  if (!state.initialized) await start();
  return computePlan({
    horizon: { days: state.config.weeklyHorizonDays, includeToday: true },
    hints,
  });
}

/**
 * requestPlan(options)
 *  - Manual API: custom horizon/domains/hints.
 */
export async function requestPlan(options = {}) {
  if (!state.initialized) await start();
  return computePlan(options);
}

export default {
  start,
  planDay,
  planWeek,
  requestPlan,
};
