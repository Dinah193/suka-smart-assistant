// File: src/agents/runtime/selectors/index.js
// SSA Agents Runtime Selectors (Context Builders)
//
// Purpose:
// - Provide "selector" functions shims use to build Reasoner context from local state (Dexie).
// - Keep shims thin: shims call selectXContext(input) to retrieve normalized context.
//
// Design goals:
// - Resilient to missing tables/modules during build-out.
// - Safe defaults: never throw unless explicitly asked.
// - Avoid hard-coupling to one db path; attempt known modules.
// - Output should be JSON-serializable.
//
// Current exports expected by shims:
// - selectStorehouseContext(input)
// - (optional) selectPreservationContext(input) for preservationShim.js
// - selectSoilWaterContext(input) for soilAndWaterShim.js
// - selectSpiceContext(input) for spiceShim.js
// - selectWasteToCompostContext(input) for wasteToCompostShim.js
//
// You can add more as shims expand:
// - selectCleaningContext, selectGardenContext, selectAnimalsContext, etc.

const SOURCE = "agents/runtime/selectors";

/* -------------------------------------------------------------------------- */
/* Utilities                                                                  */
/* -------------------------------------------------------------------------- */

function isoNow() {
  return new Date().toISOString();
}

function safeString(v, fallback = "") {
  return typeof v === "string" ? v : fallback;
}

function safeArray(v) {
  return Array.isArray(v) ? v : [];
}

function safeObject(v) {
  return v && typeof v === "object" && !Array.isArray(v) ? v : {};
}

function uniqBy(arr, keyFn) {
  const out = [];
  const seen = new Set();
  for (const item of safeArray(arr)) {
    const k = keyFn(item);
    if (k == null) continue;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out;
}

function cap(arr, n) {
  const a = safeArray(arr);
  return a.length <= n ? a : a.slice(0, n);
}

function normalizeId(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s : null;
}

/* -------------------------------------------------------------------------- */
/* DB resolver (best-effort)                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Best-effort DB resolver.
 * Attempts to import your Dexie instance from common project modules.
 *
 * If no DB is found, selectors will still return valid context
 * (just with fewer fields populated).
 */
async function resolveDb() {
  if (resolveDb._cached !== undefined) return resolveDb._cached;
  resolveDb._cached = null;

  const candidates = [
    "@/services/db",
    "@/services/db/index",
    "@/db",
    "@/db/index",
    "@/services/db.js",
    // If you later standardize a path, put it first.
  ];

  for (const spec of candidates) {
    try {
      // NOTE: Vite requires literal paths; these are literals.
      // eslint-disable-next-line no-await-in-loop
      const mod = await import(/* @vite-ignore */ spec);
      const db =
        mod?.db ||
        mod?.default ||
        mod?.sukaDb ||
        mod?.ssaDb ||
        mod?.database ||
        null;

      if (db) {
        resolveDb._cached = db;
        return db;
      }
    } catch {
      // ignore and continue
    }
  }

  return null;
}

/* -------------------------------------------------------------------------- */
/* Table helpers (safe)                                                       */
/* -------------------------------------------------------------------------- */

async function safeTableToArray(table, limit = 200) {
  try {
    if (!table) return [];
    if (
      typeof table.limit === "function" &&
      typeof table.toArray === "function"
    ) {
      return await table.limit(limit).toArray();
    }
    if (typeof table.toArray === "function") {
      const rows = await table.toArray();
      return cap(rows, limit);
    }
    if (typeof table.toCollection === "function") {
      const rows = await table.toCollection().limit(limit).toArray();
      return rows;
    }
    return [];
  } catch {
    return [];
  }
}

async function safeGetByKey(table, key) {
  try {
    if (!table || key == null) return null;
    if (typeof table.get === "function") return await table.get(key);
    return null;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Preferences / profile extraction                                            */
/* -------------------------------------------------------------------------- */

function normalizeDietPrefs(prefs = {}) {
  const p = safeObject(prefs);
  return {
    dietStyle: p.dietStyle || p.diet || null, // keto/carnivore/vegetarian/etc.
    avoid: safeArray(p.avoid),
    allergies: safeArray(p.allergies),
    kosherStyle: p.kosherStyle || null, // if you use it internally
    notes: p.notes || null,
  };
}

function normalizeHouseholdProfile(profile = {}) {
  const h = safeObject(profile);
  return {
    householdId: h.householdId || h.id || null,
    name: h.name || null,
    peopleCount: Number.isFinite(Number(h.peopleCount))
      ? Number(h.peopleCount)
      : null,
    adults: Number.isFinite(Number(h.adults)) ? Number(h.adults) : null,
    children: Number.isFinite(Number(h.children)) ? Number(h.children) : null,
    location: h.location || null,
    timezone: h.timezone || null,
  };
}

/* -------------------------------------------------------------------------- */
/* Storehouse Context                                                         */
/* -------------------------------------------------------------------------- */

/**
 * selectStorehouseContext(input)
 *
 * What it should generally provide for storehouse modes:
 * - household profile (who we are provisioning for)
 * - preferences/diet constraints
 * - inventory snapshot (at least top-level categories + counts)
 * - par targets / previous plans (if stored)
 * - recent sessions/activities (if helpful)
 *
 * It MUST NOT throw if your db tables aren’t present yet.
 *
 * @param {Object} input
 * @returns {Promise<Object>}
 */
export async function selectStorehouseContext(input = {}) {
  const now = isoNow();
  const db = await resolveDb();

  // These are *optional* assumptions about table names.
  // If they don’t exist, we just return empty arrays/objects.
  const inventoryTable =
    db?.inventory || db?.inventory_items || db?.storehouse_inventory || null;

  const householdTable =
    db?.households || db?.household || db?.household_profiles || null;

  const prefsTable =
    db?.preferences ||
    db?.user_preferences ||
    db?.household_preferences ||
    null;

  const plansTable = db?.storehouse_plans || db?.par_plans || db?.plans || null;

  // Pull what we can
  const [inventoryRows, householdRows, prefRows, planRows] = await Promise.all([
    safeTableToArray(inventoryTable, 800),
    safeTableToArray(householdTable, 50),
    safeTableToArray(prefsTable, 100),
    safeTableToArray(plansTable, 50),
  ]);

  // Choose an active household
  const householdIdFromInput = normalizeId(input.householdId);
  const activeHousehold =
    (householdIdFromInput
      ? householdRows.find(
          (h) => normalizeId(h.householdId || h.id) === householdIdFromInput
        )
      : null) ||
    householdRows[0] ||
    null;

  const householdProfile = normalizeHouseholdProfile(activeHousehold || {});

  // Preferences: choose household-specific if possible
  const prefs =
    (householdProfile.householdId
      ? prefRows.find(
          (p) =>
            normalizeId(p.householdId || p.household_id) ===
            householdProfile.householdId
        )
      : null) ||
    prefRows[0] ||
    null;

  const dietPrefs = normalizeDietPrefs(prefs || {});
  const userPrefsRaw = safeObject(prefs);

  // Inventory normalization (keep it light — Reasoner can request detail later)
  const inv = safeArray(inventoryRows).map((r) => safeObject(r));

  const byCategory = {};
  for (const row of inv) {
    const cat = safeString(
      row.category || row.group || row.type || "uncategorized",
      "uncategorized"
    );
    if (!byCategory[cat]) byCategory[cat] = { count: 0, items: [] };
    byCategory[cat].count += 1;

    // Keep a small sample so prompts don’t explode
    if (byCategory[cat].items.length < 30) {
      byCategory[cat].items.push({
        id: row.id || row.inventoryItemId || row.inventory_item_id || null,
        label: row.label || row.name || null,
        quantity: row.quantity ?? row.qty ?? null,
        unit: row.unit || null,
        location: row.location || row.storageLocation || null,
        par: row.par ?? row.target ?? null,
      });
    }
  }

  const inventorySummary = {
    totalItems: inv.length,
    categories: Object.entries(byCategory)
      .map(([category, v]) => ({
        category,
        count: v.count,
        sample: v.items,
      }))
      .sort((a, b) => b.count - a.count),
  };

  // Prior plans / PAR history (optional)
  const plans = safeArray(planRows)
    .map((p) => safeObject(p))
    .filter((p) => {
      const hid = normalizeId(p.householdId || p.household_id);
      if (!householdProfile.householdId) return true;
      if (!hid) return true;
      return hid === householdProfile.householdId;
    })
    .sort((a, b) => {
      const ta = Date.parse(a.updatedAt || a.ts || a.createdAt || 0) || 0;
      const tb = Date.parse(b.updatedAt || b.ts || b.createdAt || 0) || 0;
      return tb - ta;
    });

  const latestPlan = plans[0] || null;

  // Compact history for prompt + reasoning
  const planSummary = latestPlan
    ? {
        id: latestPlan.id || null,
        title: latestPlan.title || latestPlan.name || null,
        updatedAt:
          latestPlan.updatedAt || latestPlan.ts || latestPlan.createdAt || null,
        scope: latestPlan.scope || null,
      }
    : null;

  return {
    _meta: {
      source: SOURCE,
      domain: "storehouse",
      builtAt: now,
      dbAvailable: !!db,
    },

    household: householdProfile,
    preferences: {
      diet: dietPrefs,
      raw: userPrefsRaw,
    },

    inventory: inventorySummary,

    history: {
      latestPlan: planSummary,
      plansAvailable: plans.length,
    },

    // Additional input (so modes can see what the caller wanted)
    inputEcho: safeObject(input),
  };
}

/* -------------------------------------------------------------------------- */
/* Preservation Context                                                       */
/* -------------------------------------------------------------------------- */

/**
 * selectPreservationContext(input)
 *
 * Similar pattern to storehouse context, but biased toward:
 * - preservation inventory (jars, lids, freezer space)
 * - queued harvests / batch plans
 * - equipment availability (canner, dehydrator, smoker)
 *
 * @param {Object} input
 * @returns {Promise<Object>}
 */
export async function selectPreservationContext(input = {}) {
  const now = isoNow();
  const db = await resolveDb();

  const inventoryTable =
    db?.inventory || db?.inventory_items || db?.storehouse_inventory || null;

  const equipmentTable = db?.equipment || db?.tools || db?.appliances || null;

  const preservationQueueTable =
    db?.preservation_queue || db?.batch_queue || db?.queues || null;

  const [inventoryRows, equipmentRows, queueRows] = await Promise.all([
    safeTableToArray(inventoryTable, 800),
    safeTableToArray(equipmentTable, 200),
    safeTableToArray(preservationQueueTable, 200),
  ]);

  // Inventory: focus on container/equipment-related items
  const inv = safeArray(inventoryRows).map((r) => safeObject(r));

  const containerKeywords = [
    "jar",
    "lid",
    "ring",
    "vacuum",
    "bag",
    "freezer",
    "pan",
    "tray",
    "mylar",
    "bucket",
  ];
  const containerish = inv.filter((row) => {
    const label = safeString(row.label || row.name || "").toLowerCase();
    const cat = safeString(row.category || "").toLowerCase();
    return containerKeywords.some((k) => label.includes(k) || cat.includes(k));
  });

  const equipment = uniqBy(
    safeArray(equipmentRows).map((r) => safeObject(r)),
    (r) => normalizeId(r.id || r.toolId || r.name)
  ).map((r) => ({
    id: r.id || r.toolId || null,
    name: r.name || r.label || null,
    type: r.type || null,
    available: r.available !== false,
  }));

  const queue = safeArray(queueRows)
    .map((r) => safeObject(r))
    .map((q) => ({
      id: q.id || null,
      title: q.title || q.name || null,
      method: q.method || q.preservationMethod || null,
      status: q.status || null,
      createdAt: q.createdAt || q.ts || null,
    }));

  return {
    _meta: {
      source: SOURCE,
      domain: "preservation",
      builtAt: now,
      dbAvailable: !!db,
    },

    supplies: {
      containersSample: cap(
        containerish.map((r) => ({
          id: r.id || r.inventoryItemId || null,
          label: r.label || r.name || null,
          quantity: r.quantity ?? r.qty ?? null,
          unit: r.unit || null,
          location: r.location || r.storageLocation || null,
        })),
        80
      ),
      containersCount: containerish.length,
    },

    equipment: cap(equipment, 80),
    queue: cap(queue, 80),

    inputEcho: safeObject(input),
  };
}

/**
 * Back-compat export expected by preservationShim.js:
 *   import { getPreservationContext } from "@/agents/runtime/selectors";
 *
 * @param {Object} input
 * @returns {Promise<Object>}
 */
export async function getPreservationContext(input = {}) {
  return selectPreservationContext(input);
}

/* -------------------------------------------------------------------------- */
/* Soil + Water Context (compat export expected by soilAndWaterShim.js)        */
/* -------------------------------------------------------------------------- */

/**
 * selectSoilWaterContext(input)
 * ---------------------------------------------------------------------------
 * Compatibility selector expected by soilAndWaterShim:
 *   import { selectSoilWaterContext } from "@/agents/runtime/selectors";
 *
 * Best-effort pull of:
 * - latest soil tests / amendments
 * - irrigation / watering history
 * - water source / quality tests (if stored)
 *
 * Safe defaults if missing.
 *
 * @param {Object} input
 * @returns {Promise<Object>}
 */
export async function selectSoilWaterContext(input = {}) {
  const now = isoNow();
  const db = await resolveDb();

  const householdId = normalizeId(input.householdId);
  const gardenId = normalizeId(input.gardenId || input.garden_id);
  const plotId = normalizeId(input.plotId || input.plot_id || input.bedId);

  // Best-effort table guesses (no harm if absent)
  const soilTestsTable =
    db?.soil_tests || db?.soilTests || db?.soiltest || db?.soil || null;

  const amendmentsTable =
    db?.soil_amendments ||
    db?.amendments ||
    db?.soilAmendments ||
    db?.fertilizer_logs ||
    null;

  const irrigationTable =
    db?.irrigation_logs ||
    db?.watering_logs ||
    db?.waterings ||
    db?.irrigation ||
    null;

  const waterTestsTable =
    db?.water_tests ||
    db?.waterTests ||
    db?.water_quality ||
    db?.waterQuality ||
    null;

  const sourcesTable =
    db?.water_sources || db?.waterSources || db?.sources || null;

  const [soilRows, amendmentRows, irrigationRows, waterTestRows, sourceRows] =
    await Promise.all([
      safeTableToArray(soilTestsTable, 300),
      safeTableToArray(amendmentsTable, 300),
      safeTableToArray(irrigationTable, 400),
      safeTableToArray(waterTestsTable, 200),
      safeTableToArray(sourcesTable, 100),
    ]);

  const byScope = (rows) =>
    safeArray(rows)
      .map((r) => safeObject(r))
      .filter((r) => {
        // filter by household if possible
        if (householdId) {
          const hid = normalizeId(r.householdId || r.household_id);
          if (hid && hid !== householdId) return false;
        }
        // filter by garden/plot if provided and present in row
        if (gardenId) {
          const gid = normalizeId(r.gardenId || r.garden_id);
          if (gid && gid !== gardenId) return false;
        }
        if (plotId) {
          const pid = normalizeId(r.plotId || r.plot_id || r.bedId || r.bed_id);
          if (pid && pid !== plotId) return false;
        }
        return true;
      });

  const sortNewest = (rows) =>
    byScope(rows).sort((a, b) => {
      const ta =
        Date.parse(a.updatedAt || a.ts || a.createdAt || a.date || 0) || 0;
      const tb =
        Date.parse(b.updatedAt || b.ts || b.createdAt || b.date || 0) || 0;
      return tb - ta;
    });

  const soilTests = sortNewest(soilRows).map((r) => ({
    id: r.id || null,
    date: r.date || r.testDate || r.createdAt || r.ts || null,
    ph: r.ph ?? r.pH ?? null,
    n: r.n ?? r.nitrogen ?? null,
    p: r.p ?? r.phosphorus ?? null,
    k: r.k ?? r.potassium ?? null,
    om: r.om ?? r.organicMatter ?? null,
    notes: r.notes || null,
    scope: {
      householdId: normalizeId(r.householdId || r.household_id) || null,
      gardenId: normalizeId(r.gardenId || r.garden_id) || null,
      plotId: normalizeId(r.plotId || r.plot_id || r.bedId || r.bed_id) || null,
    },
  }));

  const amendments = sortNewest(amendmentRows).map((r) => ({
    id: r.id || null,
    date: r.date || r.appliedAt || r.createdAt || r.ts || null,
    item: r.item || r.product || r.name || null,
    amount: r.amount ?? r.qty ?? null,
    unit: r.unit || null,
    method: r.method || null,
    notes: r.notes || null,
    scope: {
      householdId: normalizeId(r.householdId || r.household_id) || null,
      gardenId: normalizeId(r.gardenId || r.garden_id) || null,
      plotId: normalizeId(r.plotId || r.plot_id || r.bedId || r.bed_id) || null,
    },
  }));

  const irrigations = sortNewest(irrigationRows).map((r) => ({
    id: r.id || null,
    date: r.date || r.atISO || r.at || r.createdAt || r.ts || null,
    volume: r.volume ?? r.amount ?? r.gallons ?? r.liters ?? null,
    unit: r.unit || (r.gallons != null ? "gal" : r.liters != null ? "L" : null),
    durationMin: r.durationMin ?? r.minutes ?? null,
    method: r.method || r.type || null,
    sourceId: normalizeId(r.sourceId || r.waterSourceId) || null,
    notes: r.notes || null,
    scope: {
      householdId: normalizeId(r.householdId || r.household_id) || null,
      gardenId: normalizeId(r.gardenId || r.garden_id) || null,
      plotId: normalizeId(r.plotId || r.plot_id || r.bedId || r.bed_id) || null,
    },
  }));

  const waterTests = sortNewest(waterTestRows).map((r) => ({
    id: r.id || null,
    date: r.date || r.testDate || r.createdAt || r.ts || null,
    sourceId: normalizeId(r.sourceId || r.waterSourceId) || null,
    ph: r.ph ?? r.pH ?? null,
    tds: r.tds ?? r.totalDissolvedSolids ?? null,
    ec: r.ec ?? r.conductivity ?? null,
    hardness: r.hardness ?? null,
    notes: r.notes || null,
  }));

  const sources = uniqBy(byScope(sourceRows), (r) =>
    normalizeId(r.id || r.sourceId || r.name)
  ).map((r) => ({
    id: r.id || r.sourceId || null,
    name: r.name || r.label || null,
    type: r.type || r.kind || null, // well/city/rain/cistern/etc.
    notes: r.notes || null,
  }));

  // Small summaries (prompt-friendly)
  const latestSoilTest = soilTests[0] || null;
  const latestWaterTest = waterTests[0] || null;

  return {
    _meta: {
      source: SOURCE,
      domain: "soil-water",
      builtAt: now,
      dbAvailable: !!db,
    },

    scope: {
      householdId: householdId || null,
      gardenId: gardenId || null,
      plotId: plotId || null,
    },

    soil: {
      latest: latestSoilTest,
      testsCount: soilTests.length,
      testsSample: cap(soilTests, 20),
      amendmentsCount: amendments.length,
      amendmentsSample: cap(amendments, 20),
    },

    water: {
      sources: cap(sources, 20),
      latestTest: latestWaterTest,
      testsCount: waterTests.length,
      testsSample: cap(waterTests, 20),
      irrigationsCount: irrigations.length,
      irrigationsSample: cap(irrigations, 25),
    },

    inputEcho: safeObject(input),
  };
}

/* -------------------------------------------------------------------------- */
/* Spice / Cooking Context (compat export expected by spiceShim.js)            */
/* -------------------------------------------------------------------------- */

/**
 * selectSpiceContext(input)
 * ---------------------------------------------------------------------------
 * Compatibility selector expected by spiceShim:
 *   import { selectSpiceContext } from "@/agents/runtime/selectors";
 *
 * Goal:
 * - Provide a compact "spice + flavor" context for cooking/cuisine reasoning:
 *   • household + diet prefs (reused from storehouse prefs if available)
 *   • cuisine preferences (if stored)
 *   • spice inventory snapshot (best-effort)
 *   • recent spice usage / recipes (best-effort)
 *
 * MUST be resilient: never throw if tables don't exist yet.
 *
 * @param {Object} input
 * @returns {Promise<Object>}
 */
export async function selectSpiceContext(input = {}) {
  const now = isoNow();
  const db = await resolveDb();

  const householdId = normalizeId(input.householdId);
  const userId = normalizeId(input.userId);

  // Best-effort tables
  const prefsTable =
    db?.preferences ||
    db?.user_preferences ||
    db?.household_preferences ||
    null;

  const cuisineTable =
    db?.cuisine_preferences ||
    db?.cuisine_prefs ||
    db?.cuisinePrefs ||
    db?.meal_preferences ||
    db?.meal_prefs ||
    null;

  const inventoryTable =
    db?.inventory || db?.inventory_items || db?.storehouse_inventory || null;

  const spiceUsageTable =
    db?.spice_usage ||
    db?.spiceUsage ||
    db?.ingredient_usage ||
    db?.ingredientUsage ||
    db?.usage_logs ||
    null;

  const recipesTable =
    db?.recipes || db?.recipe_library || db?.recipeLibrary || null;

  const [prefRows, cuisineRows, inventoryRows, usageRows, recipeRows] =
    await Promise.all([
      safeTableToArray(prefsTable, 200),
      safeTableToArray(cuisineTable, 200),
      safeTableToArray(inventoryTable, 1200),
      safeTableToArray(spiceUsageTable, 400),
      safeTableToArray(recipesTable, 400),
    ]);

  const pick = (arr) => {
    const list = safeArray(arr).map((r) => safeObject(r));

    const matchHouseholdUser =
      householdId && userId
        ? list.find((r) => {
            const hid = normalizeId(r.householdId || r.household_id);
            const uid = normalizeId(r.userId || r.user_id);
            return hid === householdId && uid === userId;
          })
        : null;

    const matchHousehold =
      householdId && !matchHouseholdUser
        ? list.find(
            (r) => normalizeId(r.householdId || r.household_id) === householdId
          )
        : null;

    const matchUser =
      userId && !matchHouseholdUser && !matchHousehold
        ? list.find((r) => normalizeId(r.userId || r.user_id) === userId)
        : null;

    return matchHouseholdUser || matchHousehold || matchUser || list[0] || null;
  };

  const prefs = pick(prefRows);
  const cuisine = pick(cuisineRows);

  const dietPrefs = normalizeDietPrefs(prefs || {});
  const cuisinePrefsRaw = safeObject(cuisine);

  // Inventory: pull "spice-ish" items
  const inv = safeArray(inventoryRows).map((r) => safeObject(r));
  const spiceKeywords = [
    "spice",
    "seasoning",
    "masala",
    "rub",
    "curry",
    "powder",
    "salt",
    "pepper",
    "paprika",
    "cumin",
    "turmeric",
    "coriander",
    "garlic",
    "onion",
    "ginger",
    "thyme",
    "oregano",
    "basil",
    "rosemary",
    "sage",
    "allspice",
    "clove",
    "cinnamon",
    "nutmeg",
    "cardamom",
    "chili",
    "cayenne",
    "suya",
    "berbere",
    "za'atar",
    "harissa",
  ];

  const spiceItems = inv
    .filter((row) => {
      const label = safeString(row.label || row.name || "").toLowerCase();
      const cat = safeString(row.category || row.group || "").toLowerCase();
      const tags = safeArray(row.tags).join(" ").toLowerCase();
      return spiceKeywords.some(
        (k) =>
          label.includes(k) || cat.includes(k) || (tags && tags.includes(k))
      );
    })
    .map((row) => ({
      id: row.id || row.inventoryItemId || row.inventory_item_id || null,
      label: row.label || row.name || null,
      quantity: row.quantity ?? row.qty ?? null,
      unit: row.unit || null,
      location: row.location || row.storageLocation || null,
      category: row.category || row.group || row.type || null,
      tags: safeArray(row.tags),
    }));

  // Usage logs (best-effort): look for spice-like entries
  const usage = safeArray(usageRows)
    .map((r) => safeObject(r))
    .filter((r) => {
      const name = safeString(
        r.name || r.label || r.ingredient || ""
      ).toLowerCase();
      const cat = safeString(r.category || r.group || "").toLowerCase();
      return spiceKeywords.some((k) => name.includes(k) || cat.includes(k));
    })
    .sort((a, b) => {
      const ta = Date.parse(a.atISO || a.date || a.createdAt || a.ts || 0) || 0;
      const tb = Date.parse(b.atISO || b.date || b.createdAt || b.ts || 0) || 0;
      return tb - ta;
    })
    .map((r) => ({
      id: r.id || null,
      atISO: r.atISO || r.date || r.createdAt || r.ts || null,
      name: r.name || r.label || r.ingredient || null,
      amount: r.amount ?? r.qty ?? null,
      unit: r.unit || null,
      recipeId: r.recipeId || null,
      notes: r.notes || null,
    }));

  // Recipes: optionally capture spice blends / tags
  const recipes = safeArray(recipeRows)
    .map((r) => safeObject(r))
    .map((r) => ({
      id: r.id || r.recipeId || null,
      title: r.title || r.name || null,
      cuisine: r.cuisine || r.cuisineId || null,
      tags: safeArray(r.tags),
    }));

  // Cuisine prefs normalization (permissive)
  const enabledCuisines = safeArray(
    cuisinePrefsRaw.enabledCuisines ||
      cuisinePrefsRaw.cuisines ||
      cuisinePrefsRaw.enabled ||
      []
  )
    .map((x) => safeString(x, "").trim())
    .filter(Boolean);

  const flavorBias = safeObject(
    cuisinePrefsRaw.flavors ||
      cuisinePrefsRaw.flavorMatrix ||
      cuisinePrefsRaw.spiceBias ||
      {}
  );

  return {
    _meta: {
      source: SOURCE,
      domain: "spice",
      builtAt: now,
      dbAvailable: !!db,
    },

    scope: {
      householdId: householdId || null,
      userId: userId || null,
    },

    preferences: {
      diet: dietPrefs,
      cuisine: {
        enabledCuisines,
        flavorBias,
        raw: cuisinePrefsRaw,
      },
      raw: safeObject(prefs),
    },

    inventory: {
      spiceItemsCount: spiceItems.length,
      spiceItemsSample: cap(spiceItems, 120),
    },

    history: {
      spiceUsageCount: usage.length,
      spiceUsageSample: cap(usage, 40),
      recipesSample: cap(recipes, 40),
    },

    inputEcho: safeObject(input),
  };
}

/* -------------------------------------------------------------------------- */
/* Waste -> Compost Context (compat export expected by wasteToCompostShim.js)  */
/* -------------------------------------------------------------------------- */

/**
 * selectWasteToCompostContext(input)
 * ---------------------------------------------------------------------------
 * Compatibility selector expected by wasteToCompostShim:
 *   import { selectWasteToCompostContext } from "@/agents/runtime/selectors";
 *
 * Goal:
 * - Provide a compact, JSON-serializable context to help map household waste
 *   into compost streams (greens/browns), bin capacity, and next actions.
 *
 * Best-effort pull of:
 * - compost bins / piles / systems (if stored)
 * - waste logs / scraps (if stored)
 * - inventory signals for browns (cardboard/leaves/wood chips) (best-effort)
 * - garden destinations (beds/plots) (best-effort)
 *
 * MUST be resilient: never throw if tables don't exist yet.
 *
 * @param {Object} input
 * @returns {Promise<Object>}
 */
export async function selectWasteToCompostContext(input = {}) {
  const now = isoNow();
  const db = await resolveDb();

  const householdId = normalizeId(input.householdId);

  // Best-effort table guesses
  const compostBinsTable =
    db?.compost_bins ||
    db?.compostBins ||
    db?.compost_systems ||
    db?.compostSystems ||
    db?.compost ||
    null;

  const wasteLogsTable =
    db?.waste_logs ||
    db?.wasteLogs ||
    db?.kitchen_scraps ||
    db?.scrap_logs ||
    db?.scraps ||
    null;

  const gardenBedsTable =
    db?.garden_beds ||
    db?.gardenBeds ||
    db?.plots ||
    db?.beds ||
    db?.garden_plots ||
    null;

  const inventoryTable =
    db?.inventory || db?.inventory_items || db?.storehouse_inventory || null;

  const [binRows, wasteRows, bedRows, inventoryRows] = await Promise.all([
    safeTableToArray(compostBinsTable, 200),
    safeTableToArray(wasteLogsTable, 500),
    safeTableToArray(gardenBedsTable, 300),
    safeTableToArray(inventoryTable, 1200),
  ]);

  // Scope filter helper
  const scoped = (rows) =>
    safeArray(rows)
      .map((r) => safeObject(r))
      .filter((r) => {
        if (!householdId) return true;
        const hid = normalizeId(r.householdId || r.household_id);
        return !hid || hid === householdId;
      });

  // Compost systems/bins
  const bins = scoped(binRows).map((r) => ({
    id: r.id || r.binId || r.systemId || null,
    name: r.name || r.label || "Compost",
    type: r.type || r.kind || null, // bin/pile/tumbler/worm/etc.
    status: r.status || null, // active/curing/paused/etc.
    capacity: r.capacity ?? r.max ?? null,
    capacityUnit: r.capacityUnit || r.unit || null,
    fillLevel: r.fillLevel ?? r.fill ?? r.level ?? null,
    location: r.location || null,
    notes: r.notes || null,
  }));

  // Waste/scraps logs: normalize and sort newest
  const waste = scoped(wasteRows)
    .sort((a, b) => {
      const ta = Date.parse(a.atISO || a.date || a.createdAt || a.ts || 0) || 0;
      const tb = Date.parse(b.atISO || b.date || b.createdAt || b.ts || 0) || 0;
      return tb - ta;
    })
    .map((r) => ({
      id: r.id || null,
      atISO: r.atISO || r.date || r.createdAt || r.ts || null,
      source: r.source || r.area || r.origin || "kitchen",
      item: r.item || r.name || r.label || null,
      category: r.category || r.type || null, // green/brown/mixed/unknown
      amount: r.amount ?? r.qty ?? null,
      unit: r.unit || null,
      moisture: r.moisture ?? null,
      notes: r.notes || null,
    }));

  // Garden destinations (beds/plots)
  const beds = scoped(bedRows).map((r) => ({
    id: r.id || r.bedId || r.plotId || null,
    name: r.name || r.label || null,
    crop: r.crop || r.currentCrop || null,
    status: r.status || null,
    location: r.location || null,
    notes: r.notes || null,
  }));

  // Inventory signals for "browns" (best-effort)
  const inv = safeArray(inventoryRows).map((r) => safeObject(r));
  const brownKeywords = [
    "cardboard",
    "paper",
    "leaves",
    "leaf",
    "wood chips",
    "woodchip",
    "sawdust",
    "straw",
    "hay",
    "shredded",
    "brown",
    "carbon",
    "mulch",
  ];

  const browns = inv
    .filter((row) => {
      const label = safeString(row.label || row.name || "").toLowerCase();
      const cat = safeString(row.category || row.group || "").toLowerCase();
      const tags = safeArray(row.tags).join(" ").toLowerCase();
      return brownKeywords.some(
        (k) =>
          label.includes(k) || cat.includes(k) || (tags && tags.includes(k))
      );
    })
    .map((row) => ({
      id: row.id || row.inventoryItemId || row.inventory_item_id || null,
      label: row.label || row.name || null,
      quantity: row.quantity ?? row.qty ?? null,
      unit: row.unit || null,
      location: row.location || row.storageLocation || null,
      category: row.category || row.group || row.type || null,
      tags: safeArray(row.tags),
    }));

  // Light summary signals (prompt-friendly)
  const latestWaste = waste[0] || null;
  const activeBins = bins.filter((b) =>
    safeString(b.status || "active", "active")
      .toLowerCase()
      .includes("active")
  );

  return {
    _meta: {
      source: SOURCE,
      domain: "waste-to-compost",
      builtAt: now,
      dbAvailable: !!db,
    },

    scope: {
      householdId: householdId || null,
    },

    compost: {
      binsCount: bins.length,
      binsSample: cap(bins, 40),
      activeBinsCount: activeBins.length,
    },

    waste: {
      logsCount: waste.length,
      latest: latestWaste,
      logsSample: cap(waste, 60),
    },

    garden: {
      bedsCount: beds.length,
      bedsSample: cap(beds, 40),
    },

    brownsInventory: {
      itemsCount: browns.length,
      itemsSample: cap(browns, 60),
    },

    inputEcho: safeObject(input),
  };
}

/* -------------------------------------------------------------------------- */
/* Sabab-specific selectors (compat exports expected by sababShim.js)          */
/* -------------------------------------------------------------------------- */

/**
 * getHouseholdContextForSabab(input)
 * ---------------------------------------------------------------------------
 * Compatibility selector expected by sababShim:
 *   import { getHouseholdContextForSabab } from "@/agents/runtime/selectors";
 *
 * Returns a lean household snapshot suitable for meal planning / sabab flows:
 * - household profile
 * - diet/preferences
 * - small inventory summary (optional but helpful)
 *
 * @param {Object} input
 * @returns {Promise<Object>}
 */
export async function getHouseholdContextForSabab(input = {}) {
  // Reuse storehouse context builder since it already provides the right shape
  // without throwing when tables are missing.
  const ctx = await selectStorehouseContext(input);

  // Keep it lean for prompts
  return {
    _meta: {
      source: SOURCE,
      domain: "sabab",
      builtAt: isoNow(),
      dbAvailable: !!ctx?._meta?.dbAvailable,
    },
    household: safeObject(ctx.household),
    preferences: safeObject(ctx.preferences),
    inventory: safeObject(ctx.inventory),
    inputEcho: safeObject(input),
  };
}

/**
 * getNutritionProfile(input)
 * ---------------------------------------------------------------------------
 * Compatibility selector expected by sababShim:
 *   import { getNutritionProfile } from "@/agents/runtime/selectors";
 *
 * Best-effort pull of nutrition/macro targets and health constraints.
 * Safe defaults if nothing is stored yet.
 *
 * @param {Object} input
 * @returns {Promise<Object>}
 */
export async function getNutritionProfile(input = {}) {
  const now = isoNow();
  const db = await resolveDb();

  const householdId = normalizeId(input.householdId);
  const userId = normalizeId(input.userId);

  // Common-ish table name guesses
  const nutritionTable =
    db?.nutrition_profiles ||
    db?.nutrition_profile ||
    db?.macro_profiles ||
    db?.macro_targets ||
    db?.health_profiles ||
    db?.healthProfile ||
    null;

  const prefsTable =
    db?.preferences ||
    db?.user_preferences ||
    db?.household_preferences ||
    null;

  const [rows, prefRows] = await Promise.all([
    safeTableToArray(nutritionTable, 200),
    safeTableToArray(prefsTable, 200),
  ]);

  // Try to find the most specific profile: household+user > household > user > first
  const pick = (arr) => {
    const list = safeArray(arr).map((r) => safeObject(r));

    const matchHouseholdUser =
      householdId && userId
        ? list.find((r) => {
            const hid = normalizeId(r.householdId || r.household_id);
            const uid = normalizeId(r.userId || r.user_id);
            return hid === householdId && uid === userId;
          })
        : null;

    const matchHousehold =
      householdId && !matchHouseholdUser
        ? list.find(
            (r) => normalizeId(r.householdId || r.household_id) === householdId
          )
        : null;

    const matchUser =
      userId && !matchHouseholdUser && !matchHousehold
        ? list.find((r) => normalizeId(r.userId || r.user_id) === userId)
        : null;

    return matchHouseholdUser || matchHousehold || matchUser || list[0] || null;
  };

  const rawProfile = pick(rows);
  const rawPrefs = pick(prefRows);

  // Normalize into a stable, prompt-friendly shape (avoid enforcing schema too hard here)
  const rp = safeObject(rawProfile);
  const pref = safeObject(rawPrefs);

  const macros = safeObject(rp.macros) || {
    calories: rp.calories ?? rp.kcal ?? null,
    protein_g: rp.protein_g ?? rp.protein ?? null,
    carbs_g: rp.carbs_g ?? rp.carbs ?? null,
    fat_g: rp.fat_g ?? rp.fat ?? null,
    fiber_g: rp.fiber_g ?? rp.fiber ?? null,
  };

  const goals = safeObject(rp.goals) || {
    goal: rp.goal || pref.goal || null, // lose/maintain/gain
    ratePerWeek: rp.ratePerWeek ?? null,
    notes: rp.notes || null,
  };

  const constraints = safeObject(rp.constraints) || {
    allergies: safeArray(rp.allergies || pref.allergies),
    avoid: safeArray(rp.avoid || pref.avoid),
    medical: safeArray(rp.medical || []),
  };

  return {
    _meta: {
      source: SOURCE,
      domain: "nutrition",
      builtAt: now,
      dbAvailable: !!db,
    },
    householdId:
      householdId || normalizeId(rp.householdId || rp.household_id) || null,
    userId: userId || normalizeId(rp.userId || rp.user_id) || null,
    macros: safeObject(macros),
    goals: safeObject(goals),
    constraints: safeObject(constraints),
    raw: rp,
    inputEcho: safeObject(input),
  };
}

/**
 * getCuisinePreferences(input)
 * ---------------------------------------------------------------------------
 * Compatibility selector expected by sababShim:
 *   import { getCuisinePreferences } from "@/agents/runtime/selectors";
 *
 * Best-effort pull of cuisine toggles / rotation preferences / flavor matrix picks.
 * Safe defaults if missing.
 *
 * @param {Object} input
 * @returns {Promise<Object>}
 */
export async function getCuisinePreferences(input = {}) {
  const now = isoNow();
  const db = await resolveDb();

  const householdId = normalizeId(input.householdId);
  const userId = normalizeId(input.userId);

  // Common-ish table name guesses
  const cuisineTable =
    db?.cuisine_preferences ||
    db?.cuisine_prefs ||
    db?.cuisinePrefs ||
    db?.meal_preferences ||
    db?.meal_prefs ||
    db?.MealPrefs ||
    null;

  const prefsTable =
    db?.preferences ||
    db?.user_preferences ||
    db?.household_preferences ||
    null;

  const [rows, prefRows] = await Promise.all([
    safeTableToArray(cuisineTable, 200),
    safeTableToArray(prefsTable, 200),
  ]);

  const pick = (arr) => {
    const list = safeArray(arr).map((r) => safeObject(r));

    const matchHouseholdUser =
      householdId && userId
        ? list.find((r) => {
            const hid = normalizeId(r.householdId || r.household_id);
            const uid = normalizeId(r.userId || r.user_id);
            return hid === householdId && uid === userId;
          })
        : null;

    const matchHousehold =
      householdId && !matchHouseholdUser
        ? list.find(
            (r) => normalizeId(r.householdId || r.household_id) === householdId
          )
        : null;

    const matchUser =
      userId && !matchHouseholdUser && !matchHousehold
        ? list.find((r) => normalizeId(r.userId || r.user_id) === userId)
        : null;

    return matchHouseholdUser || matchHousehold || matchUser || list[0] || null;
  };

  const rawCuisine = pick(rows);
  const rawPrefs = pick(prefRows);

  const c = safeObject(rawCuisine);
  const p = safeObject(rawPrefs);

  // Normalize:
  // - enabledCuisines: array of cuisine ids/names
  // - rotationBias: optional weights
  // - flavors: optional spice profile picks
  const enabledCuisines = safeArray(
    c.enabledCuisines || c.cuisines || p.enabledCuisines || p.cuisines
  )
    .map((x) => safeString(x, "").trim())
    .filter(Boolean);

  const rotationBias = safeObject(c.rotationBias || c.weights || {});
  const flavors = safeObject(c.flavors || c.flavorMatrix || {});
  const techniques = safeArray(c.techniques || c.methodPrefs || []);

  return {
    _meta: {
      source: SOURCE,
      domain: "cuisine",
      builtAt: now,
      dbAvailable: !!db,
    },
    householdId:
      householdId || normalizeId(c.householdId || c.household_id) || null,
    userId: userId || normalizeId(c.userId || c.user_id) || null,
    enabledCuisines,
    rotationBias,
    flavors,
    techniques,
    raw: c,
    inputEcho: safeObject(input),
  };
}

/**
 * getDiasporaPreferences(input)
 * ---------------------------------------------------------------------------
 * Compatibility selector expected by sababShim:
 *   import { getDiasporaPreferences } from "@/agents/runtime/selectors";
 *
 * Best-effort pull of "diaspora/cultural stream" preferences that influence
 * cuisine rotation, flavor profiles, feast-day traditions, and ingredient bias.
 *
 * Safe defaults if missing.
 *
 * @param {Object} input
 * @returns {Promise<Object>}
 */
export async function getDiasporaPreferences(input = {}) {
  const now = isoNow();
  const db = await resolveDb();

  const householdId = normalizeId(input.householdId);
  const userId = normalizeId(input.userId);

  // Common-ish table name guesses
  const diasporaTable =
    db?.diaspora_preferences ||
    db?.diaspora_prefs ||
    db?.diasporaPrefs ||
    db?.cultural_preferences ||
    db?.cultural_prefs ||
    db?.identity_preferences ||
    null;

  const prefsTable =
    db?.preferences ||
    db?.user_preferences ||
    db?.household_preferences ||
    null;

  const [rows, prefRows] = await Promise.all([
    safeTableToArray(diasporaTable, 200),
    safeTableToArray(prefsTable, 200),
  ]);

  const pick = (arr) => {
    const list = safeArray(arr).map((r) => safeObject(r));

    const matchHouseholdUser =
      householdId && userId
        ? list.find((r) => {
            const hid = normalizeId(r.householdId || r.household_id);
            const uid = normalizeId(r.userId || r.user_id);
            return hid === householdId && uid === userId;
          })
        : null;

    const matchHousehold =
      householdId && !matchHouseholdUser
        ? list.find(
            (r) => normalizeId(r.householdId || r.household_id) === householdId
          )
        : null;

    const matchUser =
      userId && !matchHouseholdUser && !matchHousehold
        ? list.find((r) => normalizeId(r.userId || r.user_id) === userId)
        : null;

    return matchHouseholdUser || matchHousehold || matchUser || list[0] || null;
  };

  const rawDiaspora = pick(rows);
  const rawPrefs = pick(prefRows);

  const d = safeObject(rawDiaspora);
  const p = safeObject(rawPrefs);

  // Normalized fields (keep permissive; you can tighten later with schemas)
  const streams = safeArray(d.streams || d.diasporaStreams || d.culturalStreams)
    .map((x) => safeString(x, "").trim())
    .filter(Boolean);

  const regions = safeArray(d.regions || d.regionTags || d.origins || [])
    .map((x) => safeString(x, "").trim())
    .filter(Boolean);

  const languages = safeArray(d.languages || d.langs || [])
    .map((x) => safeString(x, "").trim())
    .filter(Boolean);

  const householdIdentity = safeObject(d.householdIdentity || d.identity || {});
  const festivalBias = safeObject(d.festivalBias || d.feastBias || {});
  const ingredientBias = safeObject(
    d.ingredientBias || d.ingredientsBias || {}
  );

  // Provide a fallback “profile name” if you store it in prefs
  const profileName =
    safeString(
      d.profileName || d.name || p.diasporaProfile || p.culturalProfile,
      ""
    ).trim() || null;

  return {
    _meta: {
      source: SOURCE,
      domain: "diaspora",
      builtAt: now,
      dbAvailable: !!db,
    },
    householdId:
      householdId || normalizeId(d.householdId || d.household_id) || null,
    userId: userId || normalizeId(d.userId || d.user_id) || null,

    profileName,
    streams,
    regions,
    languages,

    householdIdentity,
    festivalBias,
    ingredientBias,

    raw: d,
    inputEcho: safeObject(input),
  };
}

/* -------------------------------------------------------------------------- */
/* Sausage-specific selectors (compat exports expected by sausageShim.js)      */
/* -------------------------------------------------------------------------- */

/**
 * getHouseholdContextForSausage(input)
 * ---------------------------------------------------------------------------
 * Compatibility selector expected by sausageShim:
 *   import { getHouseholdContextForSausage } from "@/agents/runtime/selectors";
 *
 * This clears the hard build error by providing the missing named export.
 * We reuse selectStorehouseContext to avoid new DB assumptions.
 *
 * @param {Object} input
 * @returns {Promise<Object>}
 */
export async function getHouseholdContextForSausage(input = {}) {
  const ctx = await selectStorehouseContext(input);

  return {
    _meta: {
      source: SOURCE,
      domain: "sausage",
      builtAt: isoNow(),
      dbAvailable: !!ctx?._meta?.dbAvailable,
    },
    household: safeObject(ctx.household),
    preferences: safeObject(ctx.preferences),
    inventory: safeObject(ctx.inventory),
    inputEcho: safeObject(input),
  };
}

/**
 * getTorahDietaryProfile(input)
 * ---------------------------------------------------------------------------
 * Compatibility selector expected by sausageShim:
 *   import { getTorahDietaryProfile } from "@/agents/runtime/selectors";
 *
 * Best-effort profile from preferences table (if present). Safe defaults.
 *
 * @param {Object} input
 * @returns {Promise<Object>}
 */
export async function getTorahDietaryProfile(input = {}) {
  const now = isoNow();
  const db = await resolveDb();

  const householdId = normalizeId(input.householdId);
  const userId = normalizeId(input.userId);

  const prefsTable =
    db?.preferences ||
    db?.user_preferences ||
    db?.household_preferences ||
    null;

  const prefRows = await safeTableToArray(prefsTable, 200);

  const pick = (arr) => {
    const list = safeArray(arr).map((r) => safeObject(r));

    const matchHouseholdUser =
      householdId && userId
        ? list.find((r) => {
            const hid = normalizeId(r.householdId || r.household_id);
            const uid = normalizeId(r.userId || r.user_id);
            return hid === householdId && uid === userId;
          })
        : null;

    const matchHousehold =
      householdId && !matchHouseholdUser
        ? list.find(
            (r) => normalizeId(r.householdId || r.household_id) === householdId
          )
        : null;

    const matchUser =
      userId && !matchHouseholdUser && !matchHousehold
        ? list.find((r) => normalizeId(r.userId || r.user_id) === userId)
        : null;

    return matchHouseholdUser || matchHousehold || matchUser || list[0] || null;
  };

  const rawPrefs = pick(prefRows);
  const p = safeObject(rawPrefs);

  return {
    _meta: {
      source: SOURCE,
      domain: "torahDietary",
      builtAt: now,
      dbAvailable: !!db,
    },
    householdId:
      householdId || normalizeId(p.householdId || p.household_id) || null,
    userId: userId || normalizeId(p.userId || p.user_id) || null,

    // keep permissive / non-opinionated; sausageShim can interpret
    dietStyle: p.dietStyle || p.diet || null,
    avoid: safeArray(p.avoid),
    allergies: safeArray(p.allergies),
    kosherStyle: p.kosherStyle || null,
    notes: p.torahDietNotes || p.dietNotes || p.notes || null,

    raw: p,
    inputEcho: safeObject(input),
  };
}

/**
 * getSabbathWindows(input)
 * ---------------------------------------------------------------------------
 * Compatibility selector expected by sausageShim:
 *   import { getSabbathWindows } from "@/agents/runtime/selectors";
 *
 * Best-effort pull of sabbath windows if you store them; otherwise returns [].
 *
 * @param {Object} input
 * @returns {Promise<Object>}
 */
export async function getSabbathWindows(input = {}) {
  const now = isoNow();
  const db = await resolveDb();

  const householdId = normalizeId(input.householdId);

  const sabbathTable =
    db?.sabbath_windows ||
    db?.sabbathWindows ||
    db?.calendar_windows ||
    db?.windows ||
    null;

  const rows = await safeTableToArray(sabbathTable, 200);

  const windows = safeArray(rows)
    .map((r) => safeObject(r))
    .filter((r) => {
      if (!householdId) return true;
      const hid = normalizeId(r.householdId || r.household_id);
      return !hid || hid === householdId;
    })
    .map((r) => ({
      id: r.id || null,
      startISO: r.startISO || r.start || r.from || null,
      endISO: r.endISO || r.end || r.to || null,
      label: r.label || r.name || "Sabbath",
      source: r.source || null,
    }));

  return {
    _meta: {
      source: SOURCE,
      domain: "sabbath",
      builtAt: now,
      dbAvailable: !!db,
    },
    windows,
    inputEcho: safeObject(input),
  };
}

/* -------------------------------------------------------------------------- */
/* Default export (optional convenience)                                      */
/* -------------------------------------------------------------------------- */

export default {
  selectStorehouseContext,
  selectPreservationContext,
  getPreservationContext,

  // Soil + water compat export
  selectSoilWaterContext,

  // Spice compat export
  selectSpiceContext,

  // Waste -> compost compat export
  selectWasteToCompostContext,

  // Sabab compat exports
  getHouseholdContextForSabab,
  getNutritionProfile,
  getCuisinePreferences,
  getDiasporaPreferences,

  // Sausage compat exports
  getHouseholdContextForSausage,
  getTorahDietaryProfile,
  getSabbathWindows,
};
