// C:\Users\larho\suka-smart-assistant\src\engines\mealToCooking.js

/**
 * mealToCooking
 * -------------
 * Purpose:
 *  - Converts "meal plan" entries into actionable Cooking Sessions.
 *  - Expands minimal meal metadata (recipeId/title/slot) into step-aware tasks,
 *    including hidden prep (preheat, boil water, thaw, soak, marinate) derived
 *    from recipe techniques and household preferences (e.g., doneness).
 *  - Checks inventory availability, attempts a soft reservation of ingredients,
 *    and emits inventory.shortage.detected when items are missing or low.
 *  - Emits standardized events back onto the eventBus so the automation runtime
 *    can schedule or start sessions.
 *  - Optionally exports Hub-friendly packets when familyFundMode is enabled.
 *
 * Pipeline fit:
 *   imports → intelligence → automation → (optional) hub export
 *   - imports: meal plans may come from scrapers/importers or manual add
 *   - intelligence: expand meal → recipe → actionable tasks (+ prefs/doneness)
 *   - automation: emit cooking.session.created & automation.schedule.request
 *   - hub export: anonymized/aggregated updates to Hub if enabled
 */

//// Soft/defensive dynamic import /////////////////////////////////////////////

async function softImport(modulePath) {
  try {
    return await import(modulePath);
  } catch {
    return null;
  }
}

//// Dependencies (loaded at start()) //////////////////////////////////////////

let eventBus;                    // required
let featureFlags = { familyFundMode: false };
let InventoryService;            // optional
let RecipeStore;                 // optional (recipes/templates/techniques)
let HouseholdPrefs;              // optional (doneness, dietary, appliances, sabbath guard)
let HubPacketFormatter;          // optional
let FamilyFundConnector;         // optional
let GuardPolicies;               // optional (quiet hours, sabbath, weather, etc.)

//// Small utilities ////////////////////////////////////////////////////////////

const nowISO = () => new Date().toISOString();

function safeId(prefix = "cook") {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return `${prefix}_${crypto.randomUUID()}`;
  }
  return `${prefix}_${Math.random().toString(36).slice(2)}_${Date.now()}`;
}

function sanitize(obj) {
  try { return JSON.parse(JSON.stringify(obj)); } catch { return undefined; }
}

function safeError(err) {
  return { name: err?.name || "Error", message: err?.message || String(err) };
}

function emit(type, source, data) {
  if (!eventBus?.emit) return;
  eventBus.emit({ type, ts: nowISO(), source, data });
}

async function exportToHubIfEnabled(payload) {
  try {
    if (!featureFlags?.familyFundMode) return;
    const packet = HubPacketFormatter?.format?.(payload, { stream: "mealToCooking" });
    if (!packet) return;
    await FamilyFundConnector?.send?.(packet);
  } catch {
    // silent fail by design
  }
}

//// Engine state //////////////////////////////////////////////////////////////

const state = {
  initialized: false,
  processing: false,
  queue: [],
  config: {
    lookaheadMinutes: 90,           // suggest session start within this window if no exact time
    defaultCookMinutes: 30,         // fallback
    reserveStrategy: "soft",        // "soft" | "hard" | "none"
    enforceGuardsOnSchedule: true,  // apply quiet hours/sabbath guard hints to schedule
    minPrepLeadMinutes: 10,         // generic lead time for hidden prep anchors
    enableSubstitutions: true,      // try to suggest subs when shortages occur
  },
};

//// Domain helpers ////////////////////////////////////////////////////////////

/**
 * Fetch a full recipe object by id/title. Degrades gracefully.
 */
async function getRecipeForMeal(meal) {
  if (!RecipeStore) return null;

  // Prioritize by explicit recipeId when present.
  if (meal?.recipeId && RecipeStore.getById) {
    try {
      const r = await RecipeStore.getById(meal.recipeId);
      if (r) return r;
    } catch {/* noop */}
  }

  // Fallback to title search.
  if (meal?.title && RecipeStore.searchByTitle) {
    try {
      const hits = await RecipeStore.searchByTitle(meal.title, { limit: 1 });
      if (Array.isArray(hits) && hits[0]) return hits[0];
    } catch {/* noop */}
  }

  return null;
}

/**
 * Return household preferences (doneness, dietary, appliances, alt-heat sources).
 */
function getPrefs() {
  return (HouseholdPrefs?.get?.() || HouseholdPrefs?.getCached?.()) ?? {};
}

/**
 * Build a doneness hint derived from preferences & recipe technique tags.
 */
function buildDonenessHint(recipe, prefs) {
  const hints = [];
  const wanted = prefs?.donenessHints || []; // e.g., ["medium-rare", "al dente", "caramelized"]

  if (Array.isArray(wanted) && wanted.length) {
    // If recipe supports any wanted doneness tags, add them.
    const recipeTags = recipe?.techniques || recipe?.tags || [];
    const overlap = recipeTags.filter((t) => wanted.includes(t));
    if (overlap.length) hints.push(...overlap);
  }

  // Add protein-specific fallback (e.g., "juicy chicken" → 160F carryover).
  if (!hints.length && Array.isArray(recipe?.proteins)) {
    if (recipe.proteins.includes("chicken")) hints.push("juicy-160F-carryover");
    if (recipe.proteins.includes("lamb")) hints.push("medium-rare");
    if (recipe.proteins.includes("beef")) hints.push("medium");
    if (recipe.proteins.includes("goat")) hints.push("tender-braise");
    if (recipe.proteins.includes("duck")) hints.push("rendered-fat-crisp-skin");
  }

  return hints.slice(0, 3);
}

/**
 * Synthesize hidden prep tasks based on recipe method & pantry realities.
 * Adds steps like thaw/soak/marinate/preheat/boil water/etc.
 */
function synthesizePrepTasks(recipe, prefs, meal) {
  const tasks = [];
  const t = (title, notes, mins = 5) => ({
    id: safeId("task"),
    type: "prep",
    title,
    notes,
    estimatedMinutes: Math.max(1, mins),
  });

  // Appliances: preheat oven/air fryer/sous-vide bath if indicated
  const methods = recipe?.methods || recipe?.techniques || [];
  if (methods.some((m) => /oven|bake|roast/i.test(m))) {
    tasks.push(t("Preheat oven", "Auto-added by mealToCooking; adjust temp in step details.", 10));
  }
  if (methods.some((m) => /air.?fry/i.test(m))) {
    tasks.push(t("Preheat air fryer", "Auto-added by mealToCooking.", 5));
  }
  if (methods.some((m) => /sous.?vide/i.test(m))) {
    tasks.push(t("Heat sous-vide bath", "Bring water bath to target temp.", 20));
  }

  // Boil water for pasta/veg
  const needsBoil = (recipe?.coreIngredients || recipe?.ingredients || [])
    .some((i) => new RegExp("\\b(pasta|noodles|potato|greens)\\b", "i").test(i?.name || i));
  if (needsBoil || methods.some((m) => /blanch|boil/i.test(m))) {
    tasks.push(t("Set pot to boil", "Start water early so it's ready for pasta/blanching.", 10));
  }

  // Thaw proteins if frozen flag present on meal or recipe (heuristic)
  if (meal?.flags?.includes("frozen") || recipe?.flags?.includes("frozen-protein")) {
    tasks.push(t("Thaw protein", "Move from freezer to fridge or use cold-water method.", 30));
  }

  // Soak beans/grains if present and dry
  const hasDryLegume = (recipe?.ingredients || []).some((i) =>
    /dry (bean|chickpea|lentil)/i.test(i?.name || i)
  );
  if (hasDryLegume) {
    tasks.push(t("Soak legumes", "Overnight preferred; quick-soak if short on time.", 60));
  }

  // Marinate when marinade is referenced
  const needsMarinade = methods.some((m) => /marinat/i.test(m));
  if (needsMarinade) {
    tasks.push(t("Prepare marinade", "Mix and coat protein; rest per recipe.", 15));
  }

  // Preference-driven anchors (dietary rinses, kosher-style rinsing, etc.)
  if (prefs?.rinsingPolicy === "always") {
    tasks.push(t("Rinse produce", "Household preference: always rinse produce before use.", 5));
  }

  return tasks;
}

/**
 * Compose session object from recipe + meal metadata + prefs/guards.
 */
function buildCookingSession(recipe, meal, prefs) {
  const id = safeId("session");
  const donenessHints = buildDonenessHint(recipe, prefs);
  const prepTasks = synthesizePrepTasks(recipe, prefs, meal);

  // Target window: respect meal.slot if present, else near-term window
  const from = meal?.slot?.start ??
    new Date(Date.now() + 5 * 60 * 1000).toISOString(); // 5 min from now
  const to = meal?.slot?.end ??
    new Date(Date.now() + state.config.lookaheadMinutes * 60 * 1000).toISOString();

  const session = {
    id,
    title: recipe?.title || meal?.title || "Cooking Session",
    domain: "cooking",
    source: "engines/mealToCooking",
    createdAt: nowISO(),
    schedule: {
      suggestedAt: nowISO(),
      window: { from, to },
      guards: deriveGuardsHints(prefs),
    },
    meta: {
      mealId: meal?.id || null,
      mealSlot: meal?.slot || null,
      recipeId: recipe?.id || null,
      recipeSource: recipe?.source || null,
      donenessHints,
      dietary: prefs?.dietary || [],
      // lightweight projection used by automation UI
      projection: {
        estimatedCookMinutes: recipe?.estimatedMinutes || state.config.defaultCookMinutes,
      },
    },
    session: {
      anchors: deriveAnchors(meal, recipe, prefs),
      tasks: [
        ...prepTasks,
        {
          id: safeId("task"),
          type: "cook",
          title: recipe?.title || "Cook",
          notes: "Session auto-generated by mealToCooking; detailed steps resolved at start.",
          estimatedMinutes: recipe?.estimatedMinutes || state.config.defaultCookMinutes,
        },
        {
          id: safeId("task"),
          type: "finish",
          title: "Rest / Plate / Serve",
          notes: "Carryover cooking, resting, and plating.",
          estimatedMinutes: 5,
        },
      ],
    },
  };

  return session;
}

function deriveAnchors(meal, recipe, prefs) {
  const anchors = [];
  // meal anchor (breakfast/lunch/dinner)
  if (meal?.slot?.label) {
    anchors.push({ type: "meal", label: String(meal.slot.label), weight: 0.9 });
  } else {
    anchors.push({ type: "meal", label: "dinner", weight: 0.7 });
  }
  // protein or technique anchors for NBA ranking
  if (Array.isArray(recipe?.proteins) && recipe.proteins.length) {
    anchors.push({ type: "protein", label: recipe.proteins[0], weight: 0.5 });
  }
  if (Array.isArray(recipe?.techniques) && recipe.techniques.length) {
    anchors.push({ type: "technique", label: recipe.techniques[0], weight: 0.4 });
  }
  // preference anchors (appliance availability)
  if (prefs?.appliances?.includes("pressure-cooker")) {
    anchors.push({ type: "appliance", label: "pressure-cooker", weight: 0.3 });
  }
  return anchors;
}

function deriveGuardsHints(prefs) {
  if (!state.config.enforceGuardsOnSchedule) return [];
  const hints = [];
  if (prefs?.guards?.quietHours) hints.push({ type: "quiet-hours", policy: "avoid" });
  if (prefs?.guards?.sabbath) hints.push({ type: "sabbath", policy: "avoid" });
  if (prefs?.guards?.weather) hints.push({ type: "weather", policy: "prefer-indoor" });
  return hints;
}

/**
 * Check inventory for the recipe; optionally reserve ingredients.
 * Emits inventory.shortage.detected if missing/low.
 */
async function checkInventoryAndMaybeReserve(recipe, meal) {
  const ingredients = recipe?.ingredients || [];
  if (!ingredients.length) return { ok: true, reservationId: null, shortages: [] };

  if (!InventoryService?.checkAvailability) {
    // Degraded: cannot check; allow session creation, rely on runtime guard.
    emit("engine.warning", "engines/mealToCooking", {
      message: "InventoryService.checkAvailability unavailable; skipping availability check.",
      mealId: meal?.id || null,
      recipeId: recipe?.id || null,
    });
    return { ok: true, reservationId: null, shortages: [] };
  }

  let availability;
  try {
    availability = await InventoryService.checkAvailability(ingredients);
  } catch (err) {
    emit("engine.warning", "engines/mealToCooking", {
      message: "Inventory availability check failed; proceeding without reservation.",
      error: safeError(err),
      mealId: meal?.id || null,
      recipeId: recipe?.id || null,
    });
    return { ok: true, reservationId: null, shortages: [] };
  }

  const shortages = (availability?.shortages || []).map(sanitize);
  if (shortages.length) {
    emit("inventory.shortage.detected", "engines/mealToCooking", {
      mealId: meal?.id || null,
      recipeId: recipe?.id || null,
      shortages,
      // Optional lightweight substitutions (if RecipeStore supports it)
      substitutions: state.config.enableSubstitutions
        ? suggestSubstitutions(shortages)
        : [],
    });
  }

  // Soft/hard reservation if configured and service supports it
  if (state.config.reserveStrategy !== "none" && InventoryService?.reserve) {
    try {
      const reservation = await InventoryService.reserve(ingredients, {
        strategy: state.config.reserveStrategy,
        reference: { type: "cooking.session", ref: meal?.id || null },
      });

      if (reservation?.id) {
        emit("inventory.updated", "engines/mealToCooking", {
          reason: "reservation",
          mealId: meal?.id || null,
          recipeId: recipe?.id || null,
          reservationId: reservation.id,
          strategy: state.config.reserveStrategy,
        });
        exportToHubIfEnabled({
          domain: "inventory",
          action: "reserved",
          payload: {
            reservationId: reservation.id,
            strategy: state.config.reserveStrategy,
            mealId: meal?.id || null,
            recipeId: recipe?.id || null,
          },
        });
      }

      return {
        ok: shortages.length === 0 || state.config.reserveStrategy === "hard" ? true : true,
        reservationId: reservation?.id || null,
        shortages,
      };
    } catch (err) {
      emit("engine.warning", "engines/mealToCooking", {
        message: "Inventory reservation failed; proceeding without reservation.",
        error: safeError(err),
        mealId: meal?.id || null,
        recipeId: recipe?.id || null,
      });
      return { ok: shortages.length === 0, reservationId: null, shortages };
    }
  }

  return { ok: shortages.length === 0, reservationId: null, shortages };
}

function suggestSubstitutions(shortages) {
  // Extension point — if RecipeStore or an IngredientGraph is available, consult it.
  // For now, return a placeholder structure per item.
  return shortages.map((s) => ({
    for: s?.name || s?.id || "unknown",
    ideas: [
      // examples; real logic would be domain-aware (flavor profile, method)
      "closest flavor profile",
      "pantry stable alternative",
      "adjust method to suit substitute",
    ],
  }));
}

//// Core processing ////////////////////////////////////////////////////////////

async function processMealRecord(meal) {
  // meal: { id, recipeId?, title?, slot?:{start,end,label}, flags?[], notes? }
  if (!meal || (typeof meal !== "object")) {
    emit("engine.warning", "engines/mealToCooking", {
      message: "Invalid meal payload.",
      preview: sanitize(meal),
    });
    return;
  }

  const recipe = await getRecipeForMeal(meal);
  if (!recipe) {
    emit("cooking.session.suggestion.none", "engines/mealToCooking", {
      mealId: meal?.id || null,
      reason: "recipe_not_found",
      title: meal?.title || null,
    });
    return;
  }

  const prefs = getPrefs();

  // 1) Inventory availability + (optional) reservation
  const inv = await checkInventoryAndMaybeReserve(recipe, meal);

  // 2) Build the session (even if shortages exist; automation UI can prompt)
  const session = buildCookingSession(recipe, meal, prefs);

  // 3) Emit creation + scheduling request; let runtime handle exact slotting
  emit("cooking.session.created", "engines/mealToCooking", {
    session,
    mealId: meal?.id || null,
    recipeId: recipe?.id || null,
    inventory: { reservationId: inv.reservationId, shortages: inv.shortages },
  });

  emit("automation.schedule.request", "engines/mealToCooking", {
    domain: "cooking",
    reason: "meal_planned",
    sessionId: session.id,
    preferredWindow: session.schedule.window,
    guards: session.schedule.guards,
    priority: shortagesPriority(inv.shortages),
  });

  // 4) Optional Hub export
  exportToHubIfEnabled({
    domain: "cooking",
    action: "session_created",
    payload: {
      sessionId: session.id,
      mealId: meal?.id || null,
      recipeId: recipe?.id || null,
      shortages: inv.shortages?.map((s) => s?.name || s) || [],
      reservationId: inv.reservationId || null,
    },
  });
}

function shortagesPriority(shortages) {
  // Fewer shortages → higher priority to schedule now; more shortages → lower priority
  const n = (shortages || []).length;
  if (n === 0) return "high";
  if (n <= 2) return "medium";
  return "low";
}

//// Queue / worker ////////////////////////////////////////////////////////////

function enqueue(meal) {
  state.queue.push(meal);
  Promise.resolve().then(drainQueue);
}

async function drainQueue() {
  if (state.processing) return;
  state.processing = true;
  try {
    while (state.queue.length) {
      const next = state.queue.shift();
      // eslint-disable-next-line no-await-in-loop
      await processMealRecord(next);
    }
  } finally {
    state.processing = false;
  }
}

//// Public API ////////////////////////////////////////////////////////////////

/**
 * start(config)
 *  - Loads dependencies
 *  - Subscribes to meal-related events:
 *      • "meal.planned"            { data: mealRecord }
 *      • "cooking.session.requested" (alternative entry) { data: mealRecord }
 *      • "import.parsed" where data.domain === "meals" and data.type === "plan"
 *  - Emits "engine.started"
 */
export async function start(config = {}) {
  if (state.initialized) return;

  state.config = { ...state.config, ...config };

  const [
    evb,
    ff,
    inv,
    rec,
    prefs,
    hubFmt,
    hubConn,
    guards,
  ] = await Promise.all([
    softImport("../services/eventBus.js"),
    softImport("../config/featureFlags.js"),
    softImport("../domain/inventory/InventoryService.js"),
    softImport("../stores/RecipeStore.js"),
    softImport("../services/HouseholdPrefs.js"),
    softImport("../hub/HubPacketFormatter.js"),
    softImport("../hub/FamilyFundConnector.js"),
    softImport("../services/guards/policies.js"),
  ]);

  eventBus = evb?.default || evb || eventBus;
  featureFlags = ff?.default || ff || featureFlags;
  InventoryService = inv?.default || inv || InventoryService;
  RecipeStore = rec?.default || rec || RecipeStore;
  HouseholdPrefs = prefs?.default || prefs || HouseholdPrefs;
  HubPacketFormatter = hubFmt?.default || hubFmt || HubPacketFormatter;
  FamilyFundConnector = hubConn?.default || hubConn || FamilyFundConnector;
  GuardPolicies = guards?.default || guards || GuardPolicies;

  if (!eventBus?.on || !eventBus?.emit) {
    throw new Error("mealToCooking requires a functional eventBus with on/emit.");
  }

  // Canonical entry: a user or importer planned a meal
  eventBus.on("meal.planned", (evt) => {
    const meal = evt?.data;
    enqueue(meal);
  });

  // Alternative entry: direct session request from UI or agent with meal data
  eventBus.on("cooking.session.requested", (evt) => {
    const meal = evt?.data?.meal || evt?.data; // accept either shape
    enqueue(meal);
  });

  // Importer entry: parsed a meal plan from outside site/app
  eventBus.on("import.parsed", (evt) => {
    const d = evt?.data;
    if (d?.domain === "meals" && d?.type === "plan" && Array.isArray(d?.items)) {
      d.items.forEach((m) => enqueue({
        id: m.id || safeId("meal"),
        recipeId: m.recipeId,
        title: m.title || d?.meta?.title,
        slot: m.slot || d?.slot || null,
        flags: m.flags || [],
        notes: m.notes,
        sourceImport: sanitize(d?.source),
      }));
    }
  });

  // Extension point: listen for preservation.completed to re-map meal plans
  // eventBus.on("preservation.completed", (evt) => { ...future logic... });

  state.initialized = true;

  emit("engine.started", "engines/mealToCooking", {
    config: sanitize(state.config),
    degraded: {
      inventory: !InventoryService,
      recipes: !RecipeStore,
      prefs: !HouseholdPrefs,
      guards: !GuardPolicies,
    },
  });
}

/**
 * planMealToCooking(mealRecord)
 *  - Manual API to convert a meal to a cooking session
 */
export async function planMealToCooking(mealRecord) {
  if (!state.initialized) {
    await start();
  }
  enqueue(mealRecord);
  return { enqueued: true };
}

export default {
  start,
  planMealToCooking,
};
