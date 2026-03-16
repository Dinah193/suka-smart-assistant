// C:\Users\larho\suka-smart-assistant\src\engines\preservationScheduler.js

/**
 * preservationScheduler
 * ---------------------
 * Purpose:
 *  - Turn perishable inflows (harvests, bulk purchases, butchery) and inventory surpluses
 *    into actionable preservation sessions (freeze, can, dehydrate, ferment, cure).
 *  - Choose methods based on food safety, household prefs, equipment, and weather.
 *  - Emit standardized events for automation scheduling and analytics.
 *  - Optionally export anonymized summaries to the Hub when familyFundMode is enabled.
 *
 * Pipeline (imports → intelligence → automation → (optional) hub export):
 *  - imports: garden.harvest.logged, import.parsed (storehouse/animal), inventory.updated
 *  - intelligence: detect surplus/perishables → compute best preservation method & session(s)
 *  - automation: emit preservation.session.created + automation.schedule.request
 *  - hub export: summarized packet via HubPacketFormatter/FamilyFundConnector (if enabled)
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

let InventoryService; // optional (snapshot, shortages/surplus, lot metadata)
let PreservationPlaybook; // optional (method rules, time estimates, safety specs)
let HouseholdPrefs; // optional (diet, appliances, quiet hours, sabbath)
let FoodSafetyService; // optional (acidification, tested recipes, canning tables)
let CalendarService; // optional (availability windows)
let WeatherService; // optional (prefer indoor if heatwave)
let SessionStore; // optional (dedupe)
let HubPacketFormatter; // optional
let FamilyFundConnector; // optional

//// Utilities /////////////////////////////////////////////////////////////////

const nowISO = () => new Date().toISOString();

function safeId(prefix = "preserve") {
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
    const pkt = HubPacketFormatter?.format?.(payload, {
      stream: "preservationScheduler",
    });
    if (!pkt) return;
    await FamilyFundConnector?.send?.(pkt);
  } catch {
    /* silent by design */
  }
}

//// Engine state //////////////////////////////////////////////////////////////

const state = {
  initialized: false,
  processing: false,
  queue: [],
  config: {
    // Triggers
    perishHoursSoft: 48, // items expiring within this window are prioritized
    surplusThreshold: 1.5, // >150% of preferred stock = surplus
    batchMinQty: 0.5, // don't schedule batches smaller than this (units are item-specific)
    preferLowNoiseAtNight: true,
    // Scheduling
    lookaheadHours: 48,
    defaultDurationMin: 45,
    perBatchCapMinutes: 120, // split into multiple sessions if > 2 hours
    // Dedupe
    dedupeKey: (s) =>
      `${s.meta?.method}:${s.meta?.itemKey}:${s.meta?.lotId || "n/a"}`,
  },
};

//// Core helpers //////////////////////////////////////////////////////////////

function hoursFromNow(iso) {
  if (!iso) return Infinity;
  const diffMs = new Date(iso).getTime() - Date.now();
  return diffMs / 3600000;
}

function buildWindowFromCalendar(minutes = 60) {
  const from = new Date();
  const to = new Date(Date.now() + minutes * 60000);
  return { from: from.toISOString(), to: to.toISOString() };
}

function deriveGuards(prefs, method, noisy = false, hot = false) {
  const hints = [];
  if (prefs?.guards?.sabbath) hints.push({ type: "sabbath", policy: "avoid" });
  if (
    prefs?.guards?.quietHours &&
    (noisy || /blend|vacuum|grind/i.test(method))
  ) {
    hints.push({ type: "quiet-hours", policy: "avoid" });
  }
  if (prefs?.guards?.weather && hot)
    hints.push({ type: "weather", policy: "prefer-indoor" });
  return hints;
}

function canUseMethod(method, item, prefs) {
  // Appliance guard & dietary guard (extendable)
  const appl = prefs?.appliances || [];
  if (method === "pressure-can" && !appl.includes("pressure-canner"))
    return false;
  if (
    method === "water-bath" &&
    !appl.includes("stockpot") &&
    !appl.includes("canner")
  )
    return false;
  if (
    method === "dehydrate" &&
    !appl.includes("dehydrator") &&
    !appl.includes("oven")
  )
    return false;
  if (method === "ferment" && prefs?.diet === "no-ferments") return false;
  // Example allergen: skip nut-butters if peanut allergy
  if (
    (item?.tags || []).includes("peanut") &&
    (prefs?.allergies || []).includes("peanut")
  )
    return false;
  return true;
}

function preferIndoor(weather) {
  return weather && weather.outdoorOk === false;
}

function chooseMethod(item, prefs, weather) {
  // 1) If playbook exists, ask it.
  if (PreservationPlaybook?.choose) {
    try {
      const m = PreservationPlaybook.choose(item, { prefs, weather });
      if (m && canUseMethod(m, item, prefs)) return m;
    } catch {
      /* noop */
    }
  }

  // 2) Safety-driven defaults
  //    - Low-acid vegetables/meat: pressure can or freeze
  //    - High-acid fruit/tomato (with acidification): water bath, freeze, dehydrate
  const acid = (item?.safety?.acid || item?.acid) ?? null;
  const protein =
    (item?.tags || []).includes("meat") ||
    (item?.tags || []).includes("poultry");

  if (protein || acid === "low") {
    if (canUseMethod("freeze", item, prefs)) return "freeze";
    if (canUseMethod("pressure-can", item, prefs)) return "pressure-can";
  } else {
    if (canUseMethod("water-bath", item, prefs)) return "water-bath";
    if (canUseMethod("dehydrate", item, prefs)) return "dehydrate";
    if (canUseMethod("freeze", item, prefs)) return "freeze";
  }

  // 3) Weather preference
  if (preferIndoor(weather) && canUseMethod("freeze", item, prefs))
    return "freeze";

  // 4) Fallback
  return canUseMethod("freeze", item, prefs) ? "freeze" : null;
}

function estimateDurationMinutes(item, method) {
  // Ask playbook first
  if (PreservationPlaybook?.estimateMinutes) {
    try {
      return Math.max(
        10,
        Number(PreservationPlaybook.estimateMinutes(item, method))
      );
    } catch {
      /* noop */
    }
  }
  // heuristic
  const base = {
    freeze: 25,
    dehydrate: 90,
    "water-bath": 75,
    "pressure-can": 120,
    ferment: 30,
    cure: 60,
  };
  return base[method] || state.config.defaultDurationMin;
}

function estimateNoiseHeat(method) {
  // used to derive guard hints
  const noisy = /dehydrate/.test(method) ? true : /grind|blend/.test(method);
  const hot = /pressure-can|water-bath/.test(method);
  return { noisy, hot };
}

function buildSession(item, method, prefs, weather) {
  const id = safeId("session");
  const duration = estimateDurationMinutes(item, method);
  const { noisy, hot } = estimateNoiseHeat(method);

  const session = {
    id,
    title: `${methodLabel(method)} ${item.title || item.name || item.itemKey}`,
    domain: "preservation",
    source: "engines/preservationScheduler",
    createdAt: nowISO(),
    schedule: {
      suggestedAt: nowISO(),
      window: buildWindowFromCalendar(
        Math.min(duration + 15, state.config.perBatchCapMinutes)
      ),
      guards: deriveGuards(prefs, method, noisy, hot || preferIndoor(weather)),
    },
    meta: {
      method,
      itemKey: item.itemKey || item.name || item.id,
      lotId: item.lotId || null,
      perishBy: item.perishBy || null,
      qty: item.qty,
      unit: item.unit || "unit",
      safety: item.safety || null,
      outdoor: false,
      noisy,
    },
    session: {
      anchors: [{ type: "task", label: method, weight: 0.9 }],
      tasks: [
        {
          id: safeId("task"),
          type: "prep",
          title: "Sort/Trim/Wash",
          estimatedMinutes: 10,
        },
        ...(method === "water-bath"
          ? [
              {
                id: safeId("task"),
                type: "prep",
                title: "Sterilize jars/lids",
                estimatedMinutes: 15,
              },
            ]
          : []),
        ...(method === "pressure-can"
          ? [
              {
                id: safeId("task"),
                type: "prep",
                title: "Load pressure canner, vent, bring to pressure",
                estimatedMinutes: 20,
              },
            ]
          : []),
        ...(method === "dehydrate"
          ? [
              {
                id: safeId("task"),
                type: "prep",
                title: "Slice to uniform thickness",
                estimatedMinutes: 10,
              },
            ]
          : []),
        ...(method === "ferment"
          ? [
              {
                id: safeId("task"),
                type: "prep",
                title: "Salt/Brine/Veg prep",
                estimatedMinutes: 15,
              },
            ]
          : []),
        {
          id: safeId("task"),
          type: "preserve",
          title: methodLabel(method),
          estimatedMinutes: duration,
        },
        {
          id: safeId("task"),
          type: "store",
          title: "Label & log to storehouse",
          estimatedMinutes: 5,
        },
      ],
    },
  };

  return session;
}

function methodLabel(m) {
  switch (m) {
    case "freeze":
      return "Freeze Batch";
    case "dehydrate":
      return "Dehydrate Batch";
    case "water-bath":
      return "Water-Bath Can";
    case "pressure-can":
      return "Pressure Can";
    case "ferment":
      return "Ferment";
    case "cure":
      return "Cure";
    default:
      return "Preserve";
  }
}

function isCandidate(item) {
  // item: { itemKey/name, qty, unit, perishBy?, safety?, tags?, lotId? }
  const qty = Number(item?.qty || 0);
  if (!qty || qty < state.config.batchMinQty) return false;
  // Perish window or explicit surplus flag
  if (
    item?.perishBy &&
    hoursFromNow(item.perishBy) <= state.config.perishHoursSoft
  )
    return true;
  if (item?.surplus === true) return true;
  // If we have preferred vs current stock info
  if (typeof item?.preferred === "number" && typeof item?.onHand === "number") {
    return (
      item.onHand / Math.max(1, item.preferred) >= state.config.surplusThreshold
    );
  }
  return false;
}

async function enrichSafety(item) {
  // Compute basic safety metadata; prefer FoodSafetyService when available.
  if (item?.safety) return item;
  let safety = null;
  if (FoodSafetyService?.classify) {
    try {
      safety = await FoodSafetyService.classify(item.name || item.itemKey);
    } catch {
      /* noop */
    }
  }
  if (!safety) {
    // heuristics
    const s = (item.name || item.itemKey || "").toLowerCase();
    if (/\b(tomato|berries|stone fruit|apple|cucumber|pickl)/.test(s))
      safety = { acid: "high" };
    else if (/\b(chicken|beef|pork|goat|lamb|duck)/.test(s))
      safety = { acid: "low", protein: true };
    else safety = { acid: "low" };
  }
  return { ...item, safety };
}

function dedupeSessions(sessions) {
  const seen = new Set();
  const out = [];
  for (const s of sessions) {
    const k = state.config.dedupeKey(s);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(s);
    }
  }
  return out;
}

//// Intake / Candidate discovery /////////////////////////////////////////////

async function discoverCandidatesFromInventory(snapshot) {
  // Expect snapshot.items: [{ itemKey, qty, unit, perishBy?, preferred?, onHand? , lotId? }]
  const items = (snapshot?.items || []).map((i) => ({
    itemKey: i.itemKey || i.name,
    name: i.name || i.itemKey,
    qty: Number(i.onHand ?? i.qty ?? 0),
    unit: i.unit || "unit",
    perishBy: i.perishBy || null,
    preferred: typeof i.preferred === "number" ? i.preferred : null,
    onHand: typeof i.onHand === "number" ? i.onHand : Number(i.qty || 0),
    lotId: i.lotId || null,
    tags: i.tags || [],
    surplus: i.surplus === true,
  }));

  const enriched = [];
  for (const it of items) {
    if (!isCandidate(it)) continue;
    // eslint-disable-next-line no-await-in-loop
    enriched.push(await enrichSafety(it));
  }
  return enriched;
}

function candidatesFromHarvest(evtData) {
  // evtData: { items:[{ name, qty, unit, perishBy? }], harvestId }
  return (evtData?.items || []).map((i) => ({
    itemKey: (i.name || "").toLowerCase(),
    name: i.name,
    qty: Number(i.qty || 0),
    unit: i.unit || "unit",
    perishBy: i.perishBy || addHours(nowISO(), state.config.perishHoursSoft),
    lotId: evtData?.harvestId || evtData?.id || null,
    tags: ["produce"],
    surplus: true, // harvested batches are strong candidates
  }));
}

function addHours(iso, h) {
  const d = new Date(iso);
  d.setHours(d.getHours() + h);
  return d.toISOString();
}

//// Core processing ////////////////////////////////////////////////////////////

async function processTrigger(trigger) {
  // trigger: { source: "harvest"|"inventory"|"import", payload }
  const prefs =
    (HouseholdPrefs?.get?.() || HouseholdPrefs?.getCached?.()) ?? {};
  const weather = WeatherService?.getSnapshot
    ? await WeatherService.getSnapshot().catch(() => null)
    : null;

  let candidates = [];

  if (trigger?.source === "harvest") {
    candidates = candidatesFromHarvest(trigger.payload);
    // Enrich safety for each harvest item
    candidates = await Promise.all(candidates.map(enrichSafety));
  }

  if (trigger?.source === "inventory") {
    const snapshot =
      trigger.payload ||
      (InventoryService?.snapshot
        ? await InventoryService.snapshot().catch(() => null)
        : null);
    if (snapshot) candidates = await discoverCandidatesFromInventory(snapshot);
  }

  if (trigger?.source === "import") {
    // Imports (bulk buys / animal processing / gleaning)
    const items = (trigger?.payload?.items || []).map((i) => ({
      itemKey: (i.name || "").toLowerCase(),
      name: i.name,
      qty: Number(i.qty || 0),
      unit: i.unit || "unit",
      perishBy: i.perishBy || addHours(nowISO(), state.config.perishHoursSoft),
      lotId: trigger?.payload?.id || null,
      tags: i.tags || [],
      surplus: true,
    }));
    candidates = await Promise.all(items.map(enrichSafety));
  }

  if (!candidates.length) {
    emit("preservation.suggestion.none", "engines/preservationScheduler", {
      reason: "no_candidates",
    });
    return;
  }

  // For each candidate, choose method and build session
  let sessions = [];
  for (const item of candidates) {
    const method = chooseMethod(item, prefs, weather);
    if (!method) {
      emit("preservation.method.none", "engines/preservationScheduler", {
        item: sanitize(item),
      });
      continue;
    }
    const session = buildSession(item, method, prefs, weather);
    sessions.push(session);
  }

  // Dedupe against recent/identical
  sessions = dedupeSessions(sessions);

  // Optional: consult SessionStore to avoid repeats
  if (SessionStore?.existsLike) {
    const filtered = [];
    for (const s of sessions) {
      // eslint-disable-next-line no-await-in-loop
      const exists = await SessionStore.existsLike(state.config.dedupeKey(s));
      if (!exists) filtered.push(s);
    }
    sessions = filtered;
  }

  if (!sessions.length) {
    emit("preservation.suggestion.none", "engines/preservationScheduler", {
      reason: "deduped_or_no_method",
    });
    return;
  }

  // Emit creation + schedule requests
  for (const s of sessions) {
    emit("preservation.session.created", "engines/preservationScheduler", {
      session: sanitize(s),
    });
    emit("automation.schedule.request", "engines/preservationScheduler", {
      domain: "preservation",
      reason: "perish_or_surplus",
      sessionId: s.id,
      preferredWindow: s.schedule?.window,
      priority: priorityFromItem(s.meta),
    });
  }

  // Optional Hub export (summarized)
  exportToHubIfEnabled({
    domain: "preservation",
    action: "sessions_created",
    payload: {
      count: sessions.length,
      methods: sessions.map((s) => s.meta?.method),
      items: sessions.map((s) => s.meta?.itemKey),
    },
  });
}

function priorityFromItem(meta) {
  const h = meta?.perishBy ? hoursFromNow(meta.perishBy) : Infinity;
  if (h <= 12) return "high";
  if (h <= 36) return "medium";
  return "low";
}

//// Queue/worker //////////////////////////////////////////////////////////////

function enqueue(trigger) {
  state.queue.push(trigger);
  Promise.resolve().then(drainQueue);
}

async function drainQueue() {
  if (state.processing) return;
  state.processing = true;
  try {
    while (state.queue.length) {
      const t = state.queue.shift();
      // eslint-disable-next-line no-await-in-loop
      await processTrigger(t);
    }
  } finally {
    state.processing = false;
  }
}

//// Public API ////////////////////////////////////////////////////////////////

/**
 * start(config)
 *  - Loads dependencies
 *  - Subscribes to:
 *      • garden.harvest.logged                  (fresh produce inflow)
 *      • inventory.updated                      (surplus/perishability changes)
 *      • import.parsed (storehouse|animal)      (bulk buy, butchery)
 *  - Emits engine.started
 */
export async function start(config = {}) {
  if (state.initialized) return;

  state.config = { ...state.config, ...config };

  const [
    evb,
    ff,
    inv,
    playbook,
    prefs,
    safety,
    cal,
    weather,
    sess,
    hubFmt,
    hubConn,
  ] = await Promise.all([
    softImport("../services/events/eventBus.js"),
    softImport("@/config/featureFlags.json"),
    softImport("../domain/inventory/InventoryService.js"),
    softImport("../domain/preservation/PreservationPlaybook.js"),
    softImport("../services/HouseholdPrefs.js"),
    softImport("../services/FoodSafetyService.js"),
    softImport("../services/CalendarService.js"),
    softImport("../services/WeatherService.js"),
    softImport("../stores/SessionStore.js"),
    softImport("@/services/hub/HubPacketFormatter.js"),
    softImport("@/services/hub/FamilyFundConnector.js"),
  ]);

  eventBus = evb?.default || evb || eventBus;
  featureFlags = ff?.default || ff || featureFlags;
  InventoryService = inv?.default || inv || InventoryService;
  PreservationPlaybook = playbook?.default || playbook || PreservationPlaybook;
  HouseholdPrefs = prefs?.default || prefs || HouseholdPrefs;
  FoodSafetyService = safety?.default || safety || FoodSafetyService;
  CalendarService = cal?.default || cal || CalendarService;
  WeatherService = weather?.default || weather || WeatherService;
  SessionStore = sess?.default || sess || SessionStore;
  HubPacketFormatter = hubFmt?.default || hubFmt || HubPacketFormatter;
  FamilyFundConnector = hubConn?.default || hubConn || FamilyFundConnector;

  if (!eventBus?.on || !eventBus?.emit) {
    throw new Error(
      "preservationScheduler requires a functional eventBus with on/emit."
    );
  }

  // Harvest inflow → immediate candidates
  eventBus.on("garden.harvest.logged", (evt) => {
    const data = evt?.data;
    if (!data?.items?.length) return;
    enqueue({ source: "harvest", payload: data });
  });

  // Inventory updates → rescan for surplus/perishables
  eventBus.on("inventory.updated", (evt) => {
    // if reason suggests inflow or nearing expiry, enqueue a scan
    const reason = evt?.data?.reason || "";
    if (
      /harvest|purchase|butchery|adjust|reservation_release|expiry/i.test(
        reason
      )
    ) {
      enqueue({ source: "inventory", payload: null }); // snapshot taken inside
    }
  });

  // Imports: storehouse/animal/butchery bulk events
  eventBus.on("import.parsed", (evt) => {
    const d = evt?.data;
    if (!d?.domain || !Array.isArray(d?.items)) return;
    if (["storehouse", "animal", "butchery"].includes(d.domain)) {
      enqueue({ source: "import", payload: d });
    }
  });

  state.initialized = true;

  emit("engine.started", "engines/preservationScheduler", {
    config: sanitize(state.config),
    degraded: {
      inventory: !InventoryService,
      playbook: !PreservationPlaybook,
      prefs: !HouseholdPrefs,
      foodSafety: !FoodSafetyService,
      calendar: !CalendarService,
      weather: !WeatherService,
      sessionStore: !SessionStore,
    },
  });
}

/**
 * scheduleNow(triggerLike)
 *  - Manual API: feed a trigger to compute preservation sessions immediately.
 *    Examples:
 *      scheduleNow({ source:"inventory" })
 *      scheduleNow({ source:"harvest", payload:{ items:[...] }})
 */
export async function scheduleNow(trigger = { source: "inventory" }) {
  if (!state.initialized) await start();
  enqueue(trigger);
  return { enqueued: true };
}

export default { start, scheduleNow };
