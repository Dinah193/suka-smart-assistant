// C:\Users\larho\suka-smart-assistant\src\engines\harvestMealLinker.js

/**
 * harvestMealLinker
 * -----------------
 * Purpose:
 *   - Listens for garden harvest events and intelligently links harvested items to
 *     near-term meal opportunities (recipes/sessions) based on availability, seasonality,
 *     and household preferences.
 *   - Updates inventory with fresh harvest deltas.
 *   - Emits standardized events back onto the shared eventBus so automations can schedule sessions.
 *   - Optionally exports a Hub-friendly packet when familyFundMode is enabled.
 *
 * How it fits the pipeline:
 *   imports → intelligence → automation → (optional) hub export
 *   - imports: "garden.harvest.logged" may originate from scanner/importers or manual entry
 *   - intelligence: match harvested items against recipe templates / knowledge graph
 *   - automation: emit events (inventory.updated, cooking.meal.suggested) so the scheduler can act
 *   - hub export: if enabled, format + send anonymized/aggregated packet to the Hub
 */

// --- Soft/defensive imports (local services are optional, engine still runs in degraded mode) ---

async function softImport(modulePath) {
  try {
    // Works in modern bundlers / Node ESM. In older environments, this is tree-shaken or polyfilled.
    return await import(modulePath);
  } catch {
    return null; // degrade gracefully
  }
}

// Event bus (required)
let eventBus;
// Feature flags (optional)
let featureFlags = { familyFundMode: false };
// Inventory service/repo (optional but recommended)
let InventoryService;
// Recipe/Template store (optional; used for suggestions)
let TemplateStore;
// Preferences/Household profile (optional; for doneness, diet, etc.)
let HouseholdPrefs;
// Hub exports (optional)
let HubPacketFormatter;
let FamilyFundConnector;

// Minimal ISO timestamp helper
const nowISO = () => new Date().toISOString();

// Random ID generator (crypto if available; otherwise fallback)
function generateId(prefix = "hm") {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return `${prefix}_${crypto.randomUUID()}`;
  }
  return `${prefix}_${Math.random().toString(36).slice(2)}_${Date.now()}`;
}

// --- Engine state (simple queue for bursty harvest logs) ---
const state = {
  initialized: false,
  processing: false,
  queue: [],
  config: {
    // Extension points for future domains (preservation/animal/storehouse)
    maxSuggestions: 5,
    minIngredientMatchRatio: 0.5, // at least 50% of core ingredients should be covered by harvest+inventory
    lookaheadDays: 7, // suggest meals within the next week
    inventoryNamespace: "storehouse", // which inventory bucket to affect
  },
};

// --- Hub export (silent fail) ---
async function exportToHubIfEnabled(payload) {
  try {
    if (!featureFlags?.familyFundMode) return;

    const base = HubPacketFormatter?.format
      ? HubPacketFormatter.format(payload, { stream: "harvestMealLinker" })
      : null;

    if (!base) return;

    await FamilyFundConnector?.send?.(base);
  } catch {
    // silently ignore hub errors by design
  }
}

// --- Event emit helper (normalized shape) ---
function emit(type, source, data) {
  if (!eventBus?.emit) return;
  eventBus.emit({ type, ts: nowISO(), source, data });
}

// --- Inventory helpers ---
async function upsertHarvestIntoInventory(harvest) {
  // harvest: { id, items: [{ name, qty, unit }], harvestedAt, gardenZone?, notes? }
  if (!harvest || !Array.isArray(harvest.items) || harvest.items.length === 0)
    return { updated: false };

  // If InventoryService exists, call it; otherwise just emit an event as a “virtual update”
  if (InventoryService?.addOrIncrementBatch) {
    try {
      const res = await InventoryService.addOrIncrementBatch(harvest.items, {
        namespace: state.config.inventoryNamespace,
        source: "garden",
        referenceId: harvest.id || null,
      });

      emit("inventory.updated", "engines/harvestMealLinker", {
        reason: "garden_harvest",
        harvestId: harvest.id || null,
        namespace: state.config.inventoryNamespace,
        delta: harvest.items,
        result: sanitizeForEvent(res),
      });

      exportToHubIfEnabled({
        domain: "inventory",
        action: "update",
        reason: "garden_harvest",
        payload: {
          harvestId: harvest.id || null,
          delta: harvest.items,
          namespace: state.config.inventoryNamespace,
        },
      });

      return { updated: true, result: res };
    } catch (err) {
      emit("inventory.update.failed", "engines/harvestMealLinker", {
        reason: "garden_harvest",
        error: safeError(err),
        delta: harvest.items,
      });
      return { updated: false, error: err };
    }
  } else {
    // Degraded mode: emit informational event only
    emit("inventory.updated", "engines/harvestMealLinker", {
      reason: "garden_harvest_degraded",
      harvestId: harvest.id || null,
      namespace: state.config.inventoryNamespace,
      delta: harvest.items,
      result: { mode: "degraded_no_inventory_service" },
    });
    return { updated: true, degraded: true };
  }
}

// --- Suggestion helpers (recipes from templates/knowledge graph) ---

/**
 * Find candidate recipes that can use the harvested items.
 * Degrades gracefully if TemplateStore is not present.
 */
async function findRecipeCandidates(harvest, prefs) {
  const harvestedNames = new Set(
    harvest.items
      .map((i) => (i?.name || "").trim().toLowerCase())
      .filter(Boolean)
  );

  if (!TemplateStore?.queryByIngredients) {
    // No template store; return empty candidate list in degraded mode
    return [];
  }

  // Domain-agnostic place to evolve a query object: add season, region, dietary tags, etc.
  const query = {
    includeAnyIngredients: Array.from(harvestedNames),
    seasonHint: inferSeasonFromDate(harvest.harvestedAt),
    dietary: prefs?.dietary || [],
    max: 50,
  };

  try {
    const results = await TemplateStore.queryByIngredients(query);
    return Array.isArray(results) ? results : [];
  } catch {
    return [];
  }
}

/**
 * Rank & filter recipes by match ratio and household preferences (e.g., doneness, diet).
 */
function rankAndFilterRecipes(candidates, harvest, prefs) {
  if (!Array.isArray(candidates) || candidates.length === 0) return [];

  const harvestedNames = new Set(
    harvest.items
      .map((i) => (i?.name || "").trim().toLowerCase())
      .filter(Boolean)
  );

  const scored = candidates.map((r) => {
    const core = (r?.coreIngredients || r?.ingredients || []).map((x) =>
      (x?.name || x).toString().trim().toLowerCase()
    );
    const overlap = core.filter((n) => harvestedNames.has(n));
    const ratio = core.length ? overlap.length / core.length : 0;

    // Preference scoring (very simple; extension point for richer logic)
    let prefBonus = 0;
    if (prefs?.dietary?.length && r?.tags?.length) {
      const aligned = r.tags.filter((t) => prefs.dietary.includes(t)).length;
      if (aligned > 0) prefBonus += Math.min(0.15, aligned * 0.05);
    }
    if (prefs?.donenessHints && r?.techniques) {
      // If recipe techniques support doneness hints the user cares about, add a modest boost
      const matches = r.techniques.filter((t) =>
        prefs.donenessHints.includes(t)
      ).length;
      if (matches > 0) prefBonus += Math.min(0.1, matches * 0.03);
    }

    return { recipe: r, ratio, score: ratio + prefBonus, overlap };
  });

  const filtered = scored
    .filter((s) => s.ratio >= state.config.minIngredientMatchRatio)
    .sort((a, b) => b.score - a.score)
    .slice(0, state.config.maxSuggestions);

  return filtered;
}

/**
 * Build a suggested cooking session for a given candidate.
 * Uses SSA's general session contract keys (defensive defaulting).
 */
function buildSuggestedCookingSession(candidate, harvest) {
  const id = generateId("session");
  const recipe = candidate.recipe;

  // Minimal defensive session contract (extend to your exact schema as needed)
  const session = {
    id,
    title: recipe?.title || "Suggested Meal",
    domain: "cooking",
    source: "engines/harvestMealLinker",
    createdAt: nowISO(),
    schedule: {
      suggestedAt: nowISO(),
      window: {
        from: nowISO(),
        // lightweight lookahead window; scheduler can adjust
        to: new Date(
          Date.now() + state.config.lookaheadDays * 86400000
        ).toISOString(),
      },
    },
    meta: {
      linkedHarvestId: harvest.id || null,
      harvestItems: harvest.items || [],
      recipeId: recipe?.id || null,
      recipeSource: recipe?.source || null,
      ingredientMatchRatio: candidate.ratio,
      overlapIngredients: candidate.overlap,
    },
    session: {
      // pre-populated tasks are optional; the SessionBuilder can flesh this out
      tasks: [
        {
          id: generateId("task"),
          type: "prep",
          title: "Preheat / Prep Equipment",
          notes: "Auto-added by harvestMealLinker; refine in SessionBuilder.",
          estimatedMinutes: 5,
        },
        {
          id: generateId("task"),
          type: "cook",
          title: recipe?.title || "Cook",
          notes:
            "Auto-suggested from recipe template; exact steps will be resolved by cooking engine.",
          estimatedMinutes: recipe?.estimatedMinutes || 30,
        },
      ],
      anchors: [
        // The automation runtime can place this in a meal slot or suggest times.
        { type: "meal", label: "dinner", weight: 0.8 },
      ],
    },
  };

  return session;
}

// Sanitize any heavy result object for event payloads (trim functions/large buffers)
function sanitizeForEvent(obj) {
  try {
    return JSON.parse(JSON.stringify(obj));
  } catch {
    return undefined;
  }
}

function safeError(err) {
  return { message: err?.message || String(err), name: err?.name || "Error" };
}

function inferSeasonFromDate(iso) {
  try {
    const d = iso ? new Date(iso) : new Date();
    const m = d.getMonth(); // 0..11
    // crude seasons for Northern Hemisphere; extension point for locale-aware rules
    if (m >= 2 && m <= 4) return "spring";
    if (m >= 5 && m <= 7) return "summer";
    if (m >= 8 && m <= 10) return "fall";
    return "winter";
  } catch {
    return undefined;
  }
}

// --- Core processing ---

async function processHarvestRecord(harvest) {
  // Validate inputs
  if (!harvest || !Array.isArray(harvest.items) || harvest.items.length === 0) {
    emit("engine.warning", "engines/harvestMealLinker", {
      message: "Invalid harvest payload received",
      harvestPreview: sanitizeForEvent(harvest),
    });
    return;
  }

  // 1) Update inventory with the new harvest
  await upsertHarvestIntoInventory(harvest);

  // 2) Fetch household prefs (degraded if unavailable)
  const prefs =
    (HouseholdPrefs?.get?.() || HouseholdPrefs?.getCached?.()) ?? {};

  // 3) Find candidate recipes
  const candidates = await findRecipeCandidates(harvest, prefs);
  if (!candidates.length) {
    emit("cooking.meal.suggestion.none", "engines/harvestMealLinker", {
      harvestId: harvest.id || null,
      reason: "no_recipe_candidates",
    });
    return;
  }

  // 4) Rank & filter
  const ranked = rankAndFilterRecipes(candidates, harvest, prefs);
  if (!ranked.length) {
    emit("cooking.meal.suggestion.none", "engines/harvestMealLinker", {
      harvestId: harvest.id || null,
      reason: "no_candidates_passing_threshold",
    });
    return;
  }

  // 5) Build suggested sessions
  const sessions = ranked.map((c) => buildSuggestedCookingSession(c, harvest));

  // 6) Emit suggestion events for automation runtime to schedule
  sessions.forEach((s) => {
    const payload = { suggestion: s, harvestId: harvest.id || null };
    emit("cooking.meal.suggested", "engines/harvestMealLinker", payload);
  });

  // 7) Optional Hub export (aggregate one packet)
  exportToHubIfEnabled({
    domain: "cooking",
    action: "suggested_sessions",
    payload: {
      harvestId: harvest.id || null,
      count: sessions.length,
      suggestions: sessions.map((s) => ({
        id: s.id,
        title: s.title,
        recipeId: s.meta.recipeId,
        overlapIngredients: s.meta.overlapIngredients,
        ingredientMatchRatio: s.meta.ingredientMatchRatio,
      })),
    },
  });
}

// --- Queue/worker for bursty events ---

async function drainQueue() {
  if (state.processing) return;
  state.processing = true;
  try {
    while (state.queue.length) {
      const item = state.queue.shift();
      // Allow slight microtask delay to avoid blocking UI threads
      // eslint-disable-next-line no-await-in-loop
      await processHarvestRecord(item);
    }
  } finally {
    state.processing = false;
  }
}

function enqueueHarvest(harvest) {
  state.queue.push(harvest);
  // Fire-and-forget; no debounce to keep code simple; schedulers can be added if needed
  // eslint-disable-next-line no-floating-decimals
  Promise.resolve().then(drainQueue);
}

// --- Public API ---

/**
 * Initialize the engine and wire event listeners.
 * Idempotent: safe to call multiple times.
 *
 * @param {object} config  Optional overrides (maxSuggestions, minIngredientMatchRatio, etc.)
 */
export async function start(config = {}) {
  if (state.initialized) return;

  // Bind config
  state.config = { ...state.config, ...config };

  // Load dependencies
  const [evb, ff, inv, tmpl, prefs, hubFmt, hubConn] = await Promise.all([
    softImport("../services/events/eventBus.js"),
    softImport("@/config/featureFlags.json"),
    softImport("../domain/inventory/InventoryService.js"),
    softImport("../stores/TemplateStore.js"),
    softImport("../services/HouseholdPrefs.js"),
    softImport("@/services/hub/HubPacketFormatter.js"),
    softImport("@/services/hub/FamilyFundConnector.js"),
  ]);

  eventBus = evb?.default || evb || eventBus;
  featureFlags = ff?.default || ff || featureFlags;
  InventoryService = inv?.default || inv || InventoryService;
  TemplateStore = tmpl?.default || tmpl || TemplateStore;
  HouseholdPrefs = prefs?.default || prefs || HouseholdPrefs;
  HubPacketFormatter = hubFmt?.default || hubFmt || HubPacketFormatter;
  FamilyFundConnector = hubConn?.default || hubConn || FamilyFundConnector;

  if (!eventBus?.on || !eventBus?.emit) {
    throw new Error(
      "harvestMealLinker requires a functional eventBus with on/emit."
    );
  }

  // Subscribe to garden harvest logs (canonical input)
  eventBus.on("garden.harvest.logged", (evt) => {
    // Expect evt shape { type, ts, source, data }
    const harvest = evt?.data;
    enqueueHarvest(harvest);
  });

  // Optional: support direct imports that carry garden payloads
  eventBus.on("import.parsed", (evt) => {
    const data = evt?.data;
    if (
      data?.domain === "garden" &&
      data?.type === "harvest" &&
      Array.isArray(data?.items)
    ) {
      enqueueHarvest({
        id: data.id || generateId("harvest"),
        items: data.items,
        harvestedAt: data.harvestedAt || evt?.ts || nowISO(),
        gardenZone: data.gardenZone,
        notes: data.notes,
        sourceImport: sanitizeForEvent(data?.source),
      });
    }
  });

  // Extension point: listen for preservation.completed to re-suggest recipes for preserved goods
  // eventBus.on("preservation.completed", (evt) => { ...future logic... });

  state.initialized = true;

  emit("engine.started", "engines/harvestMealLinker", {
    config: sanitizeForEvent(state.config),
    degraded: {
      inventory: !InventoryService,
      templates: !TemplateStore,
      prefs: !HouseholdPrefs,
    },
  });
}

/**
 * Manual entry point for direct usage (e.g., from a settings/tools panel)
 */
export async function linkHarvestToMeals(harvestRecord) {
  if (!state.initialized) {
    await start();
  }
  enqueueHarvest(harvestRecord);
  return { enqueued: true };
}

// --- Default export for convenience ---
export default {
  start,
  linkHarvestToMeals,
};
