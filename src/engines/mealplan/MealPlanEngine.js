/* eslint-disable no-console */
// C:\Users\larho\suka-smart-assistant\src\engines\mealplan\MealPlanEngine.js
//
// MealPlanEngine — Nutrition → Meal Plan → Grocery → Cooking Session Draft Chain
// -----------------------------------------------------------------------------
// Purpose:
//   Turn nutrition tool outputs (macros/micros + constraints) into actionable drafts:
//     NutritionTargets  -> MealPlanDraft -> GroceryDraft -> SessionDraft -> Session Started
//
// Required chain events emitted:
//   nutrition.targets.applied
//   mealplan.draft.updated
//   inventory.shortage.detected
//   grocery.draft.generated
//   session.draft.created
//   session.started
//
// SSA rules:
//   - standalone/local-first
//   - soft imports for db + eventBus
//   - no TypeScript

/* ------------------------------ Soft Imports ------------------------------ */
let db = null;
async function getDb() {
  if (db) return db;

  // Prefer "@/services/db" but support other repo shapes.
  const candidates = [
    "@/services/db",
    "@/services/db.js",
    "../../services/db",
    "../../services/db.js",
    "../../../services/db",
    "../../../services/db.js",
  ];

  for (const p of candidates) {
    try {
      // eslint-disable-next-line global-require, import/no-unresolved
      const mod = require(p);
      db = mod?.db || mod?.default || mod;
      if (db) return db;
    } catch {}
  }

  // last-resort: no db available (engine still works in-memory)
  db = null;
  return null;
}

let eventBus = { emit: () => {}, on: () => () => {} };
function getEventBus() {
  // Cache once (idempotent)
  if (getEventBus._resolved) return eventBus;

  const candidates = [
    "@/services/events/eventBus",
    "@/services/events/eventBus.js",
    "@/services/eventBus",
    "@/services/eventBus.js",
    "../../services/events/eventBus",
    "../../services/events/eventBus.js",
    "../../../services/events/eventBus",
    "../../../services/events/eventBus.js",
  ];

  for (const p of candidates) {
    try {
      // eslint-disable-next-line global-require, import/no-unresolved
      const mod = require(p);
      const eb = mod?.default || mod?.eventBus || mod;
      if (eb?.emit) {
        eventBus = eb;
        break;
      }
    } catch {}
  }

  getEventBus._resolved = true;
  return eventBus;
}

/* ----------------------------- Small Utilities ---------------------------- */
function nowIso() {
  return new Date().toISOString();
}
function makeId(prefix = "draft") {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

async function withRetry(fn, { tries = 2, label = "op" } = {}) {
  let lastErr = null;
  for (let i = 0; i < tries; i += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      return await fn();
    } catch (e) {
      lastErr = e;
      if (import.meta?.env?.DEV) {
        console.warn(
          `[MealPlanEngine:${label}] retry ${i + 1}/${tries} failed`,
          e
        );
      }
    }
  }
  throw lastErr;
}

/* -------------------------------------------------------------------------- */
/* Data Contracts (canonical shapes)                                           */
/* -------------------------------------------------------------------------- */

/**
 * NutritionTargets (canonical)
 * {
 *   id: string,
 *   householdId: string,
 *   personId: string,
 *   createdAt: ISO,
 *   appliedAt: ISO,
 *   source: { tool: "macros"|"micros"|"bmi"|"manual", runId?: string },
 *   macros: { calories?: number, proteinG?: number, carbsG?: number, fatG?: number },
 *   micros?: { [nutrientKey: string]: number },
 *   constraints?: {
 *     dietStyle?: string, // keto, mediterranean, etc.
 *     avoid?: string[],   // pork, shellfish, etc.
 *     allergens?: string[],
 *     dislikes?: string[],
 *     sodiumMaxMg?: number,
 *     sugarMaxG?: number
 *   },
 *   notes?: string
 * }
 *
 * MealPlanDraft
 * {
 *   id: string,
 *   householdId: string,
 *   personId: string,
 *   targetsId: string,
 *   createdAt: ISO,
 *   updatedAt: ISO,
 *   status: "draft"|"ready"|"error",
 *   days: number,
 *   mealsPerDay: number,
 *   plan: [
 *     { dayIndex: number, meals: [{ slot: "breakfast"|"lunch"|"dinner"|"snack", recipeId?: string, title: string, servings: number, macroEstimate?: {...} }] }
 *   ],
 *   constraintsApplied: object,
 *   errors?: { code: string, message: string }[]
 * }
 *
 * GroceryDraft
 * {
 *   id: string,
 *   householdId: string,
 *   personId: string,
 *   targetsId: string,
 *   mealPlanId: string,
 *   createdAt: ISO,
 *   updatedAt: ISO,
 *   status: "draft"|"ready"|"error",
 *   items: [{ key: string, name: string, qty: number, unit?: string, category?: string, optional?: boolean, linkedRecipeIds?: string[] }],
 *   shortages?: [{ key: string, name: string, neededQty: number, onHandQty: number, unit?: string }],
 *   edits?: { added?: any[], removedKeys?: string[], qtyOverrides?: { [key: string]: number } },
 *   errors?: { code: string, message: string }[]
 * }
 *
 * SessionDraft
 * {
 *   id: string,
 *   householdId: string,
 *   personId: string,
 *   targetsId: string,
 *   mealPlanId: string,
 *   groceryId: string,
 *   createdAt: ISO,
 *   updatedAt: ISO,
 *   status: "draft"|"ready"|"error",
 *   domain: "cooking",
 *   recipeIds: string[],
 *   steps: [{ id: string, text: string, durationSec?: number, timers?: any[], ingredients?: any[], tools?: any[] }],
 *   timers: [{ id: string, label: string, durationSec: number, stepId?: string }],
 *   errors?: { code: string, message: string }[]
 * }
 */

/* -------------------------------------------------------------------------- */
/* In-memory state model (cached tool results + drafts)                        */
/* -------------------------------------------------------------------------- */

const _cache = {
  // personId -> NutritionTargets
  targetsByPerson: new Map(),
  // personId -> MealPlanDraft
  mealPlanByPerson: new Map(),
  // personId -> GroceryDraft
  groceryByPerson: new Map(),
  // personId -> SessionDraft
  sessionByPerson: new Map(),

  // last error per person
  errorByPerson: new Map(),
};

function setError(personId, err, context = "unknown") {
  const shaped = {
    at: nowIso(),
    context,
    message: err?.message || String(err),
  };
  _cache.errorByPerson.set(personId, shaped);
  return shaped;
}

function emit(type, data) {
  const eb = getEventBus();
  try {
    eb.emit({
      type,
      ts: nowIso(),
      source: "MealPlanEngine",
      data,
    });
  } catch (e) {
    if (import.meta?.env?.DEV)
      console.warn("[MealPlanEngine] emit failed", type, e);
  }
}

/* -------------------------------------------------------------------------- */
/* Persistence helpers (Dexie)                                                 */
/* -------------------------------------------------------------------------- */

async function upsertById(tableName, row) {
  const d = await getDb();
  if (!d || !d[tableName]) return row;

  await d[tableName].put(row);
  return row;
}

async function getLatestByIndex(tableName, whereField, equalsValue) {
  const d = await getDb();
  if (!d || !d[tableName]) return null;

  // Prefer indexed where when possible.
  try {
    const rows = await d[tableName]
      .where(whereField)
      .equals(equalsValue)
      .toArray();
    if (!rows?.length) return null;
    rows.sort((a, b) =>
      String(b.updatedAt || b.appliedAt || b.createdAt || "").localeCompare(
        String(a.updatedAt || a.appliedAt || a.createdAt || "")
      )
    );
    return rows[0] || null;
  } catch {
    // fallback: scan
    const rows = await d[tableName].toCollection().toArray();
    const filtered = (rows || []).filter(
      (r) => String(r?.[whereField] || "") === String(equalsValue || "")
    );
    filtered.sort((a, b) =>
      String(b.updatedAt || b.appliedAt || b.createdAt || "").localeCompare(
        String(a.updatedAt || a.appliedAt || a.createdAt || "")
      )
    );
    return filtered[0] || null;
  }
}

async function persistTargets(targets) {
  // nutritionTargetsHistory table (added in db.js v11)
  const row = {
    ...targets,
    id: String(targets.id || makeId("targets")),
    createdAt: targets.createdAt || nowIso(),
    appliedAt: targets.appliedAt || nowIso(),
  };
  await upsertById("nutritionTargetsHistory", row);
  return row;
}

async function persistMealPlanDraft(draft) {
  const row = {
    ...draft,
    id: String(draft.id || makeId("mealplan")),
    createdAt: draft.createdAt || nowIso(),
    updatedAt: nowIso(),
  };
  await upsertById("mealPlanDrafts", row);
  return row;
}

async function persistGroceryDraft(draft) {
  const row = {
    ...draft,
    id: String(draft.id || makeId("grocery")),
    createdAt: draft.createdAt || nowIso(),
    updatedAt: nowIso(),
  };
  await upsertById("groceryDrafts", row);
  return row;
}

async function persistSessionDraft(draft) {
  const row = {
    ...draft,
    id: String(draft.id || makeId("sessdraft")),
    createdAt: draft.createdAt || nowIso(),
    updatedAt: nowIso(),
  };
  await upsertById("sessionDrafts", row);
  return row;
}

/* -------------------------------------------------------------------------- */
/* Inventory shortage detection (soft + conservative)                           */
/* -------------------------------------------------------------------------- */

async function detectInventoryShortages(groceryDraft) {
  const d = await getDb();
  if (!d || !d.inventory) return { shortages: [], hasDb: false };

  // Build a simple on-hand map by lowercase name
  const inv = await d.inventory.toCollection().toArray();
  const onHand = new Map();
  (inv || []).forEach((it) => {
    const k = String(it?.name || "")
      .trim()
      .toLowerCase();
    if (!k) return;
    const q = Number(it?.quantity ?? 0);
    onHand.set(k, (onHand.get(k) || 0) + (Number.isFinite(q) ? q : 0));
  });

  const shortages = [];
  (groceryDraft?.items || []).forEach((gi) => {
    const k = String(gi?.name || gi?.key || "")
      .trim()
      .toLowerCase();
    const needed = Number(gi?.qty ?? 0);
    if (!k || !Number.isFinite(needed) || needed <= 0) return;
    const have = Number(onHand.get(k) || 0);
    if (have < needed) {
      shortages.push({
        key: String(gi?.key || k),
        name: String(gi?.name || k),
        neededQty: needed,
        onHandQty: have,
        unit: gi?.unit || "",
      });
    }
  });

  return { shortages, hasDb: true };
}

/* -------------------------------------------------------------------------- */
/* Draft generation logic (minimal but extensible)                              */
/* -------------------------------------------------------------------------- */

function defaultMealPlanFromTargets(targets, opts = {}) {
  const days = Number(opts.days ?? 7);
  const mealsPerDay = Number(opts.mealsPerDay ?? 3);

  // Minimal stub plan: UI/agents can replace recipes later.
  const slots =
    mealsPerDay === 4
      ? ["breakfast", "lunch", "dinner", "snack"]
      : mealsPerDay === 2
      ? ["lunch", "dinner"]
      : ["breakfast", "lunch", "dinner"];

  const plan = Array.from({ length: days }).map((_, dayIndex) => ({
    dayIndex,
    meals: slots.map((slot) => ({
      slot,
      title: `Suggested ${slot}`,
      servings: 1,
      // placeholders — later you’ll map to Recipe Vault & constraints
      macroEstimate: targets?.macros ? { ...targets.macros } : {},
    })),
  }));

  return {
    id: makeId("mealplan"),
    householdId: String(targets.householdId || "household"),
    personId: String(targets.personId || "person"),
    targetsId: String(targets.id || "targets"),
    createdAt: nowIso(),
    updatedAt: nowIso(),
    status: "draft",
    days,
    mealsPerDay,
    plan,
    constraintsApplied: targets?.constraints || {},
    errors: [],
  };
}

function groceryFromMealPlanDraft(mealDraft, opts = {}) {
  // Minimal grocery: derive from meal titles; later you’ll swap for recipe ingredient expansion.
  const items = [];
  const add = (name, qty = 1, unit = "") => {
    const key = String(name).trim().toLowerCase().replace(/\s+/g, "_");
    const existing = items.find((x) => x.key === key);
    if (existing) existing.qty += qty;
    else
      items.push({
        key,
        name,
        qty,
        unit,
        category: "general",
        linkedRecipeIds: [],
      });
  };

  (mealDraft?.plan || []).forEach((day) => {
    (day?.meals || []).forEach((m) => {
      // placeholders: you will replace with real ingredient lists from Recipe Vault
      if (m?.slot === "breakfast") {
        add("eggs", 6, "pcs");
        add("milk", 1, "qt");
      } else if (m?.slot === "lunch") {
        add("chicken breast", 2, "lb");
        add("rice", 2, "lb");
      } else if (m?.slot === "dinner") {
        add("ground beef", 2, "lb");
        add("vegetables", 2, "lb");
      } else {
        add("fruit", 6, "pcs");
      }
    });
  });

  // Apply simple constraints-based removals (avoid list)
  const avoid = (mealDraft?.constraintsApplied?.avoid || []).map((x) =>
    String(x).toLowerCase()
  );
  const filtered = items.filter((it) => {
    const n = String(it.name || "").toLowerCase();
    return !avoid.some((a) => a && n.includes(a));
  });

  return {
    id: makeId("grocery"),
    householdId: mealDraft.householdId,
    personId: mealDraft.personId,
    targetsId: mealDraft.targetsId,
    mealPlanId: mealDraft.id,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    status: "draft",
    items: filtered,
    shortages: [],
    edits: { added: [], removedKeys: [], qtyOverrides: {} },
    errors: [],
    options: { source: opts.source || "MealPlanEngine.stub" },
  };
}

function sessionFromGroceryAndMealPlan({ mealDraft, groceryDraft }, opts = {}) {
  // Minimal session draft: real implementation should pull recipes + steps from Recipe Vault.
  // But it MUST be shaped correctly so Cooking Session generation can plug in.
  const recipeIds =
    opts.recipeIds && Array.isArray(opts.recipeIds) ? opts.recipeIds : [];

  const steps = [
    {
      id: makeId("step"),
      text: "Review plan and prep ingredients (mise en place).",
      durationSec: 10 * 60,
      timers: [
        { id: makeId("t"), label: "Mise en place", durationSec: 10 * 60 },
      ],
      ingredients: [],
      tools: [],
    },
    {
      id: makeId("step"),
      text: "Cook meal(s) according to selected recipes and timers.",
      durationSec: 30 * 60,
      timers: [
        { id: makeId("t"), label: "Cooking block", durationSec: 30 * 60 },
      ],
      ingredients: [],
      tools: [],
    },
  ];

  const timers = [];
  steps.forEach((s) =>
    (s.timers || []).forEach((t) => timers.push({ ...t, stepId: s.id }))
  );

  return {
    id: makeId("sessdraft"),
    householdId: mealDraft.householdId,
    personId: mealDraft.personId,
    targetsId: mealDraft.targetsId,
    mealPlanId: mealDraft.id,
    groceryId: groceryDraft.id,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    status: "draft",
    domain: "cooking",
    recipeIds,
    steps,
    timers,
    errors: [],
    options: { source: opts.source || "MealPlanEngine.stub" },
  };
}

/* -------------------------------------------------------------------------- */
/* Public Engine API                                                           */
/* -------------------------------------------------------------------------- */

export const MealPlanEngine = {
  /**
   * Load last-known drafts for a person (from Dexie if available)
   */
  async hydrateForPerson({ personId, householdId } = {}) {
    if (!personId) return null;

    const d = await getDb();
    if (!d) return null;

    const latestTargets = await getLatestByIndex(
      "nutritionTargetsHistory",
      "personId",
      String(personId)
    );
    if (latestTargets)
      _cache.targetsByPerson.set(String(personId), latestTargets);

    const latestMeal = await getLatestByIndex(
      "mealPlanDrafts",
      "personId",
      String(personId)
    );
    if (latestMeal) _cache.mealPlanByPerson.set(String(personId), latestMeal);

    const latestGrocery = await getLatestByIndex(
      "groceryDrafts",
      "personId",
      String(personId)
    );
    if (latestGrocery)
      _cache.groceryByPerson.set(String(personId), latestGrocery);

    const latestSession = await getLatestByIndex(
      "sessionDrafts",
      "personId",
      String(personId)
    );
    if (latestSession)
      _cache.sessionByPerson.set(String(personId), latestSession);

    return {
      targets: _cache.targetsByPerson.get(String(personId)) || null,
      mealPlan: _cache.mealPlanByPerson.get(String(personId)) || null,
      grocery: _cache.groceryByPerson.get(String(personId)) || null,
      session: _cache.sessionByPerson.get(String(personId)) || null,
      householdId:
        householdId ||
        latestTargets?.householdId ||
        latestMeal?.householdId ||
        null,
    };
  },

  /**
   * Step 1: Apply nutrition targets (from macros/micros tools) to the chain.
   * Emits: nutrition.targets.applied
   */
  async applyNutritionTargets(targetsInput, { autoRegenerate = true } = {}) {
    const personId = String(targetsInput?.personId || "");
    if (!personId) throw new Error("applyNutritionTargets requires personId");

    const targets = {
      ...targetsInput,
      id: String(targetsInput?.id || makeId("targets")),
      householdId: String(targetsInput?.householdId || "household"),
      personId,
      createdAt: targetsInput?.createdAt || nowIso(),
      appliedAt: nowIso(),
      source: targetsInput?.source || { tool: "manual" },
      macros: targetsInput?.macros || {},
      micros: targetsInput?.micros || {},
      constraints: targetsInput?.constraints || {},
    };

    _cache.targetsByPerson.set(personId, targets);

    await withRetry(() => persistTargets(targets), { label: "persistTargets" });

    emit("nutrition.targets.applied", {
      householdId: targets.householdId,
      personId: targets.personId,
      targetsId: targets.id,
      appliedAt: targets.appliedAt,
      targets,
    });

    if (autoRegenerate) {
      // Continue chain
      await this.regenerateMealPlan({
        householdId: targets.householdId,
        personId: targets.personId,
        targetsId: targets.id,
      });
    }

    return targets;
  },

  /**
   * Step 2: Regenerate meal plan draft using targets.
   * Emits: mealplan.draft.updated
   */
  async regenerateMealPlan({
    householdId,
    personId,
    targetsId,
    days = 7,
    mealsPerDay = 3,
  } = {}) {
    const pid = String(personId || "");
    if (!pid) throw new Error("regenerateMealPlan requires personId");

    const targets = _cache.targetsByPerson.get(pid) || null;
    if (!targets)
      throw new Error(
        "No cached NutritionTargets for person. Apply targets first."
      );

    const draft = defaultMealPlanFromTargets(
      {
        ...targets,
        householdId: householdId || targets.householdId,
        id: targetsId || targets.id,
      },
      { days, mealsPerDay }
    );

    _cache.mealPlanByPerson.set(pid, draft);

    await withRetry(() => persistMealPlanDraft(draft), {
      label: "persistMealPlanDraft",
    });

    emit("mealplan.draft.updated", {
      householdId: draft.householdId,
      personId: draft.personId,
      targetsId: draft.targetsId,
      mealPlanId: draft.id,
      updatedAt: draft.updatedAt,
      draft,
    });

    return draft;
  },

  /**
   * Step 3: Generate grocery draft from meal plan draft.
   * Also checks shortages vs inventory (if db inventory is present)
   * Emits: inventory.shortage.detected + grocery.draft.generated
   */
  async generateGroceryDraft({ householdId, personId, mealPlanId } = {}) {
    const pid = String(personId || "");
    if (!pid) throw new Error("generateGroceryDraft requires personId");

    const mealDraft =
      (mealPlanId
        ? await (async () => {
            const d = await getDb();
            if (!d?.mealPlanDrafts)
              return _cache.mealPlanByPerson.get(pid) || null;
            try {
              return await d.mealPlanDrafts.get(String(mealPlanId));
            } catch {
              return null;
            }
          })()
        : null) ||
      _cache.mealPlanByPerson.get(pid) ||
      null;

    if (!mealDraft)
      throw new Error("No MealPlanDraft found. Regenerate meal plan first.");

    const groceryDraft = groceryFromMealPlanDraft(mealDraft);

    // detect shortages
    const { shortages } = await withRetry(
      () => detectInventoryShortages(groceryDraft),
      { label: "detectInventoryShortages" }
    );
    groceryDraft.shortages = shortages || [];

    _cache.groceryByPerson.set(pid, groceryDraft);

    await withRetry(() => persistGroceryDraft(groceryDraft), {
      label: "persistGroceryDraft",
    });

    if (
      Array.isArray(groceryDraft.shortages) &&
      groceryDraft.shortages.length
    ) {
      emit("inventory.shortage.detected", {
        householdId: groceryDraft.householdId,
        personId: groceryDraft.personId,
        targetsId: groceryDraft.targetsId,
        mealPlanId: groceryDraft.mealPlanId,
        groceryId: groceryDraft.id,
        shortages: groceryDraft.shortages,
      });
    }

    emit("grocery.draft.generated", {
      householdId: groceryDraft.householdId,
      personId: groceryDraft.personId,
      targetsId: groceryDraft.targetsId,
      mealPlanId: groceryDraft.mealPlanId,
      groceryId: groceryDraft.id,
      updatedAt: groceryDraft.updatedAt,
      draft: groceryDraft,
    });

    return groceryDraft;
  },

  /**
   * Step 4: Create cooking session draft.
   * Emits: session.draft.created
   */
  async createSessionDraft({
    householdId,
    personId,
    mealPlanId,
    groceryId,
    recipeIds = [],
  } = {}) {
    const pid = String(personId || "");
    if (!pid) throw new Error("createSessionDraft requires personId");

    const mealDraft = _cache.mealPlanByPerson.get(pid) || null;
    const groceryDraft = _cache.groceryByPerson.get(pid) || null;

    if (!mealDraft)
      throw new Error("No MealPlanDraft cached. Regenerate meal plan first.");
    if (!groceryDraft)
      throw new Error("No GroceryDraft cached. Generate grocery list first.");

    // allow explicit ids to override cached (if caller passes them)
    const resolvedMeal =
      mealPlanId && String(mealPlanId) !== String(mealDraft.id)
        ? { ...mealDraft, id: String(mealPlanId) }
        : mealDraft;

    const resolvedGrocery =
      groceryId && String(groceryId) !== String(groceryDraft.id)
        ? { ...groceryDraft, id: String(groceryId) }
        : groceryDraft;

    const sessionDraft = sessionFromGroceryAndMealPlan(
      { mealDraft: resolvedMeal, groceryDraft: resolvedGrocery },
      { recipeIds }
    );

    _cache.sessionByPerson.set(pid, sessionDraft);

    await withRetry(() => persistSessionDraft(sessionDraft), {
      label: "persistSessionDraft",
    });

    emit("session.draft.created", {
      householdId: sessionDraft.householdId,
      personId: sessionDraft.personId,
      targetsId: sessionDraft.targetsId,
      mealPlanId: sessionDraft.mealPlanId,
      groceryId: sessionDraft.groceryId,
      sessionDraftId: sessionDraft.id,
      updatedAt: sessionDraft.updatedAt,
      draft: sessionDraft,
    });

    return sessionDraft;
  },

  /**
   * Step 5: Start cooking session (creates/updates db.sessions if available)
   * Emits: session.started
   *
   * NOTE:
   * - This only starts the session record + emits an event.
   * - Your existing Cooking Session UI (SessionRunner/CookingPlay) should listen for
   *   session.started and route into play/resume.
   */
  async startCookingSession({ personId, sessionDraftId } = {}) {
    const pid = String(personId || "");
    if (!pid) throw new Error("startCookingSession requires personId");

    const draft =
      (sessionDraftId
        ? await (async () => {
            const d = await getDb();
            if (!d?.sessionDrafts)
              return _cache.sessionByPerson.get(pid) || null;
            try {
              return await d.sessionDrafts.get(String(sessionDraftId));
            } catch {
              return null;
            }
          })()
        : null) ||
      _cache.sessionByPerson.get(pid) ||
      null;

    if (!draft)
      throw new Error("No SessionDraft found. Create session draft first.");

    // Try to persist into sessions table using db.saveSession if available
    let savedSession = null;
    const d = await getDb();
    if (d) {
      // Prefer db.saveSession if exported from services/db.js
      let saveSession = null;
      try {
        // eslint-disable-next-line global-require, import/no-unresolved
        const mod = require("@/services/db");
        saveSession = mod?.saveSession || mod?.default?.saveSession || null;
      } catch {}
      if (!saveSession) {
        try {
          // eslint-disable-next-line global-require
          const mod2 = require("../../services/db");
          saveSession = mod2?.saveSession || mod2?.default?.saveSession || null;
        } catch {}
      }

      if (typeof saveSession === "function") {
        savedSession = await withRetry(
          () =>
            saveSession({
              domain: "cooking",
              status: "running",
              startedAt: nowIso(),
              updatedAt: nowIso(),
              origin: "MealPlanEngine",
              sessionDraftId: draft.id,
              householdId: draft.householdId,
              personId: draft.personId,
              targetsId: draft.targetsId,
              mealPlanId: draft.mealPlanId,
              groceryId: draft.groceryId,
              steps: Array.isArray(draft.steps) ? draft.steps : [],
              timers: Array.isArray(draft.timers) ? draft.timers : [],
              recipeIds: Array.isArray(draft.recipeIds) ? draft.recipeIds : [],
            }),
          { label: "saveSession" }
        );
      } else if (d.sessions) {
        // fallback: write sessions directly (keep PK behavior you already use)
        const row = {
          sessionId: makeId("cooking"),
          id: undefined, // let Dexie assign numeric PK; db.js normalizes on saveSession, but this is a fallback
          domain: "cooking",
          status: "running",
          startedAt: nowIso(),
          updatedAt: nowIso(),
          origin: "MealPlanEngine",
          sessionDraftId: draft.id,
          householdId: draft.householdId,
          personId: draft.personId,
          targetsId: draft.targetsId,
          mealPlanId: draft.mealPlanId,
          groceryId: draft.groceryId,
          steps: Array.isArray(draft.steps) ? draft.steps : [],
          timers: Array.isArray(draft.timers) ? draft.timers : [],
          recipeIds: Array.isArray(draft.recipeIds) ? draft.recipeIds : [],
        };
        try {
          const numericId = await d.sessions.add(row);
          savedSession = {
            ...row,
            dbId: numericId,
            id: row.sessionId,
            sessionId: row.sessionId,
          };
        } catch {
          savedSession = row;
        }
      }
    }

    emit("session.started", {
      householdId: draft.householdId,
      personId: draft.personId,
      targetsId: draft.targetsId,
      mealPlanId: draft.mealPlanId,
      groceryId: draft.groceryId,
      sessionDraftId: draft.id,
      session: savedSession || null,
    });

    return savedSession || draft;
  },

  /**
   * Read-only getters for pages that want quick access without hitting Dexie.
   */
  getCached(personId) {
    const pid = String(personId || "");
    return {
      targets: _cache.targetsByPerson.get(pid) || null,
      mealPlan: _cache.mealPlanByPerson.get(pid) || null,
      grocery: _cache.groceryByPerson.get(pid) || null,
      session: _cache.sessionByPerson.get(pid) || null,
      error: _cache.errorByPerson.get(pid) || null,
    };
  },

  /**
   * Small wiring helper: pages can subscribe to the chain and rehydrate drafts.
   * Returns an unsubscribe function.
   */
  subscribeForPerson(personId, onUpdate) {
    const eb = getEventBus();
    const pid = String(personId || "");
    if (!pid || typeof eb?.on !== "function") return () => {};

    const handler = async (evt) => {
      try {
        const d = evt?.data || {};
        if (String(d?.personId || "") !== pid) return;
        const hydrated = await this.hydrateForPerson({
          personId: pid,
          householdId: d.householdId,
        });
        if (typeof onUpdate === "function") onUpdate(hydrated, evt);
      } catch (e) {
        setError(pid, e, "subscribeForPerson");
      }
    };

    const offA = eb.on("nutrition.targets.applied", handler) || (() => {});
    const offB = eb.on("mealplan.draft.updated", handler) || (() => {});
    const offC = eb.on("inventory.shortage.detected", handler) || (() => {});
    const offD = eb.on("grocery.draft.generated", handler) || (() => {});
    const offE = eb.on("session.draft.created", handler) || (() => {});
    const offF = eb.on("session.started", handler) || (() => {});

    return () => {
      try {
        offA();
      } catch {}
      try {
        offB();
      } catch {}
      try {
        offC();
      } catch {}
      try {
        offD();
      } catch {}
      try {
        offE();
      } catch {}
      try {
        offF();
      } catch {}
    };
  },

  /**
   * One-call convenience for the full user flow chain.
   * (Apply targets -> mealplan -> grocery -> session draft -> start)
   */
  async runFullChain({
    targets,
    days = 7,
    mealsPerDay = 3,
    recipeIds = [],
    autoStart = false,
  }) {
    const personId = String(targets?.personId || "");
    if (!personId) throw new Error("runFullChain requires targets.personId");

    try {
      const applied = await this.applyNutritionTargets(targets, {
        autoRegenerate: false,
      });
      const meal = await this.regenerateMealPlan({
        householdId: applied.householdId,
        personId,
        targetsId: applied.id,
        days,
        mealsPerDay,
      });
      const grocery = await this.generateGroceryDraft({
        householdId: applied.householdId,
        personId,
        mealPlanId: meal.id,
      });
      const sessDraft = await this.createSessionDraft({
        householdId: applied.householdId,
        personId,
        mealPlanId: meal.id,
        groceryId: grocery.id,
        recipeIds,
      });

      if (autoStart) {
        const started = await this.startCookingSession({
          personId,
          sessionDraftId: sessDraft.id,
        });
        return {
          targets: applied,
          mealPlan: meal,
          grocery,
          sessionDraft: sessDraft,
          started,
        };
      }

      return {
        targets: applied,
        mealPlan: meal,
        grocery,
        sessionDraft: sessDraft,
      };
    } catch (e) {
      setError(personId, e, "runFullChain");
      throw e;
    }
  },
};

export default MealPlanEngine;
