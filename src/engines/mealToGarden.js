// C:\Users\larho\suka-smart-assistant\src\engines\mealToGarden.js

/**
 * mealToGarden
 * ------------
 * Purpose:
 *  - Convert near-term meal demand into actionable garden intelligence:
 *      • Forecast crop demand from meal ingredients
 *      • Compare against current inventory and planned garden yields
 *      • Suggest harvest pulls if crops are ready now
 *      • Suggest/transmit planting & transplanting plans if future shortages predicted
 *      • Optionally emit ready-to-run Garden Sessions (sow/transplant/water/fertilize/harvest)
 *  - Emit normalized events for the automation runtime to schedule tasks.
 *  - Optionally export anonymized Hub packets when familyFundMode is enabled.
 *
 * Pipeline fit:
 *   imports → intelligence → automation → (optional) hub export
 *   - imports: meals come from importers or manual planning
 *   - intelligence: translate ingredient demand → crops; cross-check yields; plan actions
 *   - automation: emit garden.* events + optional "garden.session.created" for scheduling
 *   - hub export: send summarized signals if enabled; SSA owns data first
 */

//// Soft/defensive dynamic import /////////////////////////////////////////////

async function softImport(path) {
  try { return await import(path); } catch { return null; }
}

//// Dependencies (populated in start()) ///////////////////////////////////////

let eventBus;                     // required
let featureFlags = { familyFundMode: false };
let InventoryService;             // optional (check storehouse quantities)
let GardenStore;                  // optional (beds/plots/crops state)
let GardenYieldService;           // optional (yield forecasts by crop/date)
let SeedLibrary;                  // optional (TTM, spacing, optimal dates)
let IngredientCropMap;            // optional (ingredient → crop canonical mapping)
let HouseholdPrefs;               // optional (region/zone, sabbath/quiet guards)
let HubPacketFormatter;           // optional
let FamilyFundConnector;          // optional

//// Small utilities ///////////////////////////////////////////////////////////

const nowISO = () => new Date().toISOString();

function safeId(prefix = "garden") {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return `${prefix}_${crypto.randomUUID()}`;
  return `${prefix}_${Math.random().toString(36).slice(2)}_${Date.now()}`;
}

function emit(type, source, data) {
  if (!eventBus?.emit) return;
  eventBus.emit({ type, ts: nowISO(), source, data });
}

function sanitize(x) { try { return JSON.parse(JSON.stringify(x)); } catch { return undefined; } }
function safeError(err) { return { name: err?.name || "Error", message: err?.message || String(err) }; }

async function exportToHubIfEnabled(payload) {
  try {
    if (!featureFlags?.familyFundMode) return;
    const packet = HubPacketFormatter?.format?.(payload, { stream: "mealToGarden" });
    if (!packet) return;
    await FamilyFundConnector?.send?.(packet);
  } catch {
    // fail silently by design
  }
}

//// Engine state //////////////////////////////////////////////////////////////

const state = {
  initialized: false,
  processing: false,
  queue: [], // accepts individual meals or batches
  config: {
    lookaheadDays: 14,         // analyze meals in the next N days
    minDemandUnit: 1,          // ignore sub-minimal requests
    autoCreateSessions: true,  // emit garden.session.created for sow/transplant/harvest
    preferTransplantFor: ["tomato", "pepper", "brassica"], // defaults if SeedLibrary absent
    harvestWindowDays: 3,      // consider harvest “ready” within +/- N days of readiness
    defaultTTMDays: 60,        // fallback time-to-maturity (days) if SeedLibrary unknown
    defaultBed: "A",           // default bed/zone when GardenStore absent
  },
};

//// Core domain helpers ///////////////////////////////////////////////////////

/**
 * Extract ingredient demand from a meal or array of meals.
 * Returns a map: { cropKey: { qty, unit, sources: [{mealId, recipeId, name, qty, unit}] } }
 */
function aggregateDemand(meals) {
  const list = Array.isArray(meals) ? meals : [meals];
  const out = new Map();

  for (const meal of list) {
    const items = meal?.ingredients || meal?.projectedIngredients || []; // accept pre-projected
    const mealId = meal?.id || null;
    const recipeId = meal?.recipeId || null;

    for (const raw of items) {
      const name = (raw?.name || raw)?.toString().trim().toLowerCase();
      if (!name) continue;

      const cropKey = mapIngredientToCrop(name);
      if (!cropKey) continue;

      const qty = Number(raw?.qty ?? 1);
      const unit = (raw?.unit || "unit").toLowerCase();
      if (!qty || qty < state.config.minDemandUnit) continue;

      const prev = out.get(cropKey) || { qty: 0, unit, sources: [] };
      prev.qty += qty;
      prev.unit = unit; // naive: assumes consistent unit per crop; real impl would normalize
      prev.sources.push({ mealId, recipeId, name, qty, unit });
      out.set(cropKey, prev);
    }
  }
  return out;
}

/**
 * Map a free-text ingredient to a canonical crop key (e.g., "roma tomatoes" -> "tomato").
 * Falls back to simple heuristics if IngredientCropMap is not available.
 */
function mapIngredientToCrop(ingredientName) {
  if (IngredientCropMap?.toCropKey) {
    try { return IngredientCropMap.toCropKey(ingredientName); } catch { /* noop */ }
  }
  // Heuristic fallback (extendable)
  const s = ingredientName.toLowerCase();
  if (/\btomato(es)?\b/.test(s)) return "tomato";
  if (/\bonion(s)?\b/.test(s)) return "onion";
  if (/\bpepper(s)?\b/.test(s)) return "pepper";
  if (/\bgarlic\b/.test(s)) return "garlic";
  if (/\bbasil\b/.test(s)) return "basil";
  if (/\bcilantro|coriander\b/.test(s)) return "cilantro";
  if (/\bspinach\b/.test(s)) return "spinach";
  if (/\blettuce\b/.test(s)) return "lettuce";
  if (/\bcarrot(s)?\b/.test(s)) return "carrot";
  if (/\bpotato(es)?\b/.test(s)) return "potato";
  if (/\bgreen bean(s)?|string bean(s)?\b/.test(s)) return "green-bean";
  if (/\bzucchini|courgette\b/.test(s)) return "zucchini";
  // proteins that can be homestead-raised (forward-looking integration with animals domain)
  if (/\begg(s)?\b/.test(s)) return "egg";
  if (/\bchicken\b/.test(s)) return "chicken-meat";
  if (/\bgoat\b/.test(s)) return "goat-meat";
  if (/\blamb|mutton\b/.test(s)) return "lamb-meat";
  if (/\bduck\b/.test(s)) return "duck-meat";
  return null;
}

/**
 * Check storehouse + yields to see what's available vs. short.
 */
async function reconcileSupply(demandMap) {
  const results = [];

  for (const [cropKey, need] of demandMap.entries()) {
    const supply = { inventoryQty: 0, unit: need.unit, readyNow: 0, readySoon: 0, ttmDays: null };

    // 1) Storehouse inventory
    if (InventoryService?.getQuantityByCropKey) {
      try {
        const inv = await InventoryService.getQuantityByCropKey(cropKey, { unit: need.unit });
        supply.inventoryQty = Number(inv?.qty || 0);
      } catch (err) {
        emit("engine.warning", "engines/mealToGarden", {
          message: "Inventory lookup failed",
          cropKey, error: safeError(err),
        });
      }
    }

    // 2) Garden yields (ready windows)
    if (GardenYieldService?.getReadinessWindow) {
      try {
        const win = await GardenYieldService.getReadinessWindow(cropKey);
        // "readyNow" if within the harvest window
        const today = new Date();
        const nowReady = (win?.harvests || []).filter(h =>
          isWithinWindow(today, new Date(h.readyDate), state.config.harvestWindowDays)
        ).reduce((a, b) => a + Number(b.qty || 0), 0);

        const soonReady = (win?.harvests || []).filter(h =>
          daysBetween(today, new Date(h.readyDate)) > state.config.harvestWindowDays &&
          daysBetween(today, new Date(h.readyDate)) <= 14 // 2 weeks horizon
        ).reduce((a, b) => a + Number(b.qty || 0), 0);

        supply.readyNow = nowReady;
        supply.readySoon = soonReady;
      } catch (err) {
        emit("engine.warning", "engines/mealToGarden", {
          message: "Yield window lookup failed",
          cropKey, error: safeError(err),
        });
      }
    }

    // 3) Time-to-maturity (for planting suggestions)
    if (SeedLibrary?.get) {
      try {
        const seed = await SeedLibrary.get(cropKey);
        supply.ttmDays = Number(seed?.ttmDays || state.config.defaultTTMDays);
      } catch {
        supply.ttmDays = state.config.defaultTTMDays;
      }
    } else {
      supply.ttmDays = state.config.defaultTTMDays;
    }

    const totalSupply = (supply.inventoryQty || 0) + (supply.readyNow || 0) + (supply.readySoon || 0);
    const shortage = Math.max(0, (need.qty || 0) - totalSupply);

    results.push({ cropKey, need, supply, shortage });
  }

  return results;
}

function isWithinWindow(dayA, dayB, windowDays = 3) {
  const diff = Math.abs(daysBetween(dayA, dayB));
  return diff <= windowDays;
}

function daysBetween(a, b) {
  const MS = 86400000;
  return Math.round((b - a) / MS);
}

/**
 * Build suggested garden actions for shortages and harvest opportunities.
 */
function planGardenActions(recon) {
  const harvestRequests = [];
  const plantingPlans = [];

  for (const item of recon) {
    const { cropKey, need, supply, shortage } = item;

    // If we have readyNow > 0, ask for harvest pull (bounded by need)
    const harvestQty = Math.min(need.qty, (supply.readyNow || 0));
    if (harvestQty > 0) {
      harvestRequests.push({
        id: safeId("harvest"),
        cropKey,
        qty: harvestQty,
        unit: need.unit,
        window: buildNowWindow(),
        notes: "Derived from meal demand",
      });
    }

    // If shortage remains, suggest planting/transplanting plan
    if (shortage > 0) {
      const ttm = Number(supply.ttmDays || state.config.defaultTTMDays);
      const startDate = new Date();
      const targetReadyDate = new Date(Date.now() + ttm * 86400000);

      const method = suggestMethod(cropKey);
      const plan = {
        id: safeId("plan"),
        cropKey,
        method, // 'direct-sow' | 'transplant'
        qty: shortage,
        unit: need.unit,
        startDate: startDate.toISOString(),
        expectedReady: targetReadyDate.toISOString(),
        bed: state.config.defaultBed,
        notes: "Auto-suggested to cover predicted meal shortage",
      };
      plantingPlans.push(plan);
    }
  }

  return { harvestRequests, plantingPlans };
}

function suggestMethod(cropKey) {
  // Prefer transplant for heat-loving or slow-mature crops if SeedLibrary absent
  if (!SeedLibrary?.get) {
    if (state.config.preferTransplantFor.includes(cropKey)) return "transplant";
    return "direct-sow";
  }
  // If SeedLibrary exists, defer to its guidance
  // (pseudo: SeedLibrary.get(crop).method) — default to direct-sow on failure
  return "direct-sow";
}

/**
 * Optionally create automation-ready Garden Sessions (sow/transplant/harvest).
 */
function buildGardenSessions(actions, prefs) {
  const sessions = [];

  for (const h of actions.harvestRequests) {
    sessions.push({
      id: safeId("session"),
      title: `Harvest ${h.cropKey}`,
      domain: "garden",
      source: "engines/mealToGarden",
      createdAt: nowISO(),
      schedule: {
        suggestedAt: nowISO(),
        window: h.window,
        guards: deriveGuardsHints(prefs),
      },
      meta: {
        type: "harvest",
        cropKey: h.cropKey,
        qty: h.qty, unit: h.unit,
        reason: "meal_demand",
      },
      session: {
        anchors: [{ type: "task", label: "harvest", weight: 0.9 }],
        tasks: [
          { id: safeId("task"), type: "harvest", title: `Harvest ${h.cropKey}`, estimatedMinutes: 10 },
          { id: safeId("task"), type: "store", title: "Log to storehouse", estimatedMinutes: 5 },
        ],
      },
    });
  }

  for (const p of actions.plantingPlans) {
    sessions.push({
      id: safeId("session"),
      title: `${p.method === "transplant" ? "Transplant" : "Sow"} ${p.cropKey}`,
      domain: "garden",
      source: "engines/mealToGarden",
      createdAt: nowISO(),
      schedule: {
        suggestedAt: nowISO(),
        window: buildStartWindow(p.startDate),
        guards: deriveGuardsHints(prefs),
      },
      meta: {
        type: p.method === "transplant" ? "transplant" : "sow",
        cropKey: p.cropKey,
        qty: p.qty, unit: p.unit,
        expectedReady: p.expectedReady,
        bed: p.bed,
        reason: "meal_shortage_forecast",
      },
      session: {
        anchors: [{ type: "task", label: p.method, weight: 0.9 }],
        tasks: [
          { id: safeId("task"), type: "prep-bed", title: `Prep bed ${p.bed}`, estimatedMinutes: 15 },
          { id: safeId("task"), type: p.method, title: `${p.method} ${p.cropKey}`, estimatedMinutes: 15 },
          { id: safeId("task"), type: "water", title: "Water in", estimatedMinutes: 5 },
          { id: safeId("task"), type: "fertilize", title: "Light fertilizer (if applicable)", estimatedMinutes: 5 },
        ],
      },
    });
  }

  return sessions;
}

function deriveGuardsHints(prefs) {
  const hints = [];
  if (prefs?.guards?.sabbath) hints.push({ type: "sabbath", policy: "avoid" });
  if (prefs?.guards?.weather) hints.push({ type: "weather", policy: "prefer-cool-hours" });
  return hints;
}

function buildNowWindow() {
  const from = new Date();
  const to = new Date(Date.now() + 3 * 24 * 3600 * 1000);
  return { from: from.toISOString(), to: to.toISOString() };
}

function buildStartWindow(startISO) {
  const from = startISO ? new Date(startISO) : new Date();
  const to = new Date(from.getTime() + 3 * 24 * 3600 * 1000);
  return { from: from.toISOString(), to: to.toISOString() };
}

//// Processing ////////////////////////////////////////////////////////////////

async function processMeals(meals) {
  const prefs = (HouseholdPrefs?.get?.() || HouseholdPrefs?.getCached?.()) ?? {};
  const demand = aggregateDemand(meals);
  if (demand.size === 0) {
    emit("garden.suggestion.none", "engines/mealToGarden", {
      reason: "no_cultivable_ingredients_found",
    });
    return;
  }

  // Compare demand vs. supply (inventory + yields)
  const recon = await reconcileSupply(demand);

  // Partition into harvest & planting actions
  const actions = planGardenActions(recon);

  // Emit harvest requests
  if (actions.harvestRequests.length) {
    emit("garden.harvest.requested", "engines/mealToGarden", {
      requests: sanitize(actions.harvestRequests),
    });
  }

  // Emit planting suggestions
  if (actions.plantingPlans.length) {
    emit("garden.planting.suggested", "engines/mealToGarden", {
      plans: sanitize(actions.plantingPlans),
    });
  }

  // Auto-create Garden Sessions if enabled
  if (state.config.autoCreateSessions) {
    const sessions = buildGardenSessions(actions, prefs);
    for (const s of sessions) {
      emit("garden.session.created", "engines/mealToGarden", { session: s });
      emit("automation.schedule.request", "engines/mealToGarden", {
        domain: "garden",
        reason: s.meta?.type === "harvest" ? "harvest_pull" : "planting_plan",
        sessionId: s.id,
        preferredWindow: s.schedule?.window,
        guards: s.schedule?.guards,
        priority: s.meta?.type === "harvest" ? "high" : "medium",
      });
    }

    // Optional hub export: summarize signal
    exportToHubIfEnabled({
      domain: "garden",
      action: "sessions_created",
      payload: {
        counts: {
          harvest: sessions.filter(x => x.meta?.type === "harvest").length,
          plant: sessions.filter(x => x.meta?.type !== "harvest").length,
        },
        crops: sessions.map(s => s.meta?.cropKey).filter(Boolean),
      },
    });
  } else {
    // Optional hub export: suggestions only
    exportToHubIfEnabled({
      domain: "garden",
      action: "suggestions_emitted",
      payload: {
        harvestRequests: actions.harvestRequests.length,
        plantingPlans: actions.plantingPlans.length,
      },
    });
  }
}

//// Queue/worker //////////////////////////////////////////////////////////////

function enqueue(mealOrMeals) {
  // Normalize: engine accepts 1 meal or array of meals
  state.queue.push(mealOrMeals);
  Promise.resolve().then(drainQueue);
}

async function drainQueue() {
  if (state.processing) return;
  state.processing = true;
  try {
    while (state.queue.length) {
      const next = state.queue.shift();
      // eslint-disable-next-line no-await-in-loop
      await processMeals(next);
    }
  } finally {
    state.processing = false;
  }
}

//// Public API ////////////////////////////////////////////////////////////////

/**
 * start(config)
 *  - Loads dependencies
 *  - Subscribes to events:
 *      • "meal.planned"                          { data: mealRecord }
 *      • "meal.batch.planned"                    { data: [mealRecord...] }
 *      • "import.parsed" (meals → plan/items)    { data: { domain:"meals", type:"plan", items:[...] } }
 *  - Emits "engine.started"
 */
export async function start(config = {}) {
  if (state.initialized) return;

  state.config = { ...state.config, ...config };

  const [
    evb,
    ff,
    inv,
    gstore,
    gyield,
    seedlib,
    cropmap,
    prefs,
    hubFmt,
    hubConn,
  ] = await Promise.all([
    softImport("../services/eventBus.js"),
    softImport("../config/featureFlags.js"),
    softImport("../domain/inventory/InventoryService.js"),
    softImport("../domain/garden/GardenStore.js"),
    softImport("../domain/garden/GardenYieldService.js"),
    softImport("../domain/garden/SeedLibrary.js"),
    softImport("../domain/garden/IngredientCropMap.js"),
    softImport("../services/HouseholdPrefs.js"),
    softImport("../hub/HubPacketFormatter.js"),
    softImport("../hub/FamilyFundConnector.js"),
  ]);

  eventBus = evb?.default || evb || eventBus;
  featureFlags = ff?.default || ff || featureFlags;
  InventoryService = inv?.default || inv || InventoryService;
  GardenStore = gstore?.default || gstore || GardenStore;
  GardenYieldService = gyield?.default || gyield || GardenYieldService;
  SeedLibrary = seedlib?.default || seedlib || SeedLibrary;
  IngredientCropMap = cropmap?.default || cropmap || IngredientCropMap;
  HouseholdPrefs = prefs?.default || prefs || HouseholdPrefs;
  HubPacketFormatter = hubFmt?.default || hubFmt || HubPacketFormatter;
  FamilyFundConnector = hubConn?.default || hubConn || FamilyFundConnector;

  if (!eventBus?.on || !eventBus?.emit) {
    throw new Error("mealToGarden requires a functional eventBus with on/emit.");
  }

  // Single meal planned
  eventBus.on("meal.planned", (evt) => {
    const meal = evt?.data;
    if (!meal) return;
    enqueue(meal);
  });

  // Batch meal planning (e.g., weekly planner)
  eventBus.on("meal.batch.planned", (evt) => {
    const meals = evt?.data;
    if (!Array.isArray(meals) || meals.length === 0) return;
    enqueue(meals);
  });

  // Importer entry: parsed external meal plan
  eventBus.on("import.parsed", (evt) => {
    const d = evt?.data;
    if (d?.domain === "meals" && d?.type === "plan" && Array.isArray(d?.items)) {
      enqueue(d.items.map(m => ({
        id: m.id || safeId("meal"),
        recipeId: m.recipeId,
        title: m.title || d?.meta?.title,
        slot: m.slot || d?.slot || null,
        ingredients: m.ingredients || m.projectedIngredients || [],
        flags: m.flags || [],
        notes: m.notes,
        sourceImport: sanitize(d?.source),
      })));
    }
  });

  // (Optional) When inventory changes, re-run if there were pending shortages (future)
  // eventBus.on("inventory.updated", (evt) => { ...could enqueue a re-check... });

  state.initialized = true;

  emit("engine.started", "engines/mealToGarden", {
    config: sanitize(state.config),
    degraded: {
      inventory: !InventoryService,
      gardenStore: !GardenStore,
      yieldService: !GardenYieldService,
      seedLibrary: !SeedLibrary,
      cropMap: !IngredientCropMap,
    },
  });
}

/**
 * analyzeMealsForGarden(meals)
 *  - Manual API: feed one or many meal records for planning.
 */
export async function analyzeMealsForGarden(meals) {
  if (!state.initialized) await start();
  enqueue(meals);
  return { enqueued: true };
}

export default { start, analyzeMealsForGarden };
