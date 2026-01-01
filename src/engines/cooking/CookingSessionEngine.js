/* eslint-disable no-console */
// src/engines/cooking/CookingSessionEngine.js
// CookingSessionEngine
// -----------------------------------------------------------------------------
// Builds, consolidates, schedules, and persists cooking/batch sessions.
// Domains covered: single-meal prep, multi-recipe batch, defrost/marinade,
// appliance orchestration (oven/range/instant pot), label printing hooks,
// and post-cook cleanup suggestions.
//
// Highlights
// - Draft → Consolidate → Guard → Schedule → Persist → Emit
// - Per-task scheduledFor + sequence ordering
// - One-time or recurring (RRULE via local automation runtime)
// - User-owned favorites & plan templates (distinct from system presets)
// - Reverse generation: from Inventory, Garden harvest, Animals processing
// - NBA (Next Best Action) hints + voice-friendly summaries
// - Cross-domain orchestration (Calendar, Inventory, Meals, Cleaning, Scan•Compare•Trust)
//
// Soft integrations (safe imports so file never crashes):
// - DexieDB "@/db" (expects sessions, plans, favorites tables if present)
// - Local automation runtime "@/services/automation/runtime"
// - Guards "@/services/session/guards" (sabbath, quiet-hours, weather, fasting?, etc.)
// - CalendarWriter "@/services/calendar/CalendarWriter"
// - Event catalog "@/features/scan-compare-trust/automation/events.catalog.js"
// - ProductResolver "@/features/scan-compare-trust/services/products/ProductResolver"
// - Coupon/Price services (nudges only) under Scan•Compare•Trust
// - SessionRunner "@/services/session/SessionRunner"
//
// Nutrition → MealPlan → Grocery → Session wiring (NEW):
// - Reads SessionDrafts created by MealPlanEngine (if present)
// - Builds a cooking session with consolidated steps + timers when recipe steps exist
// - Emits chain events:
//     nutrition.targets.applied → mealplan.draft.updated → inventory.shortage.detected
//     → grocery.draft.generated → session.draft.created → session.started
// - Uses soft-import eventBus path + soft-import services/db for upsert patterns

import EventEmitter from "eventemitter3";

/* --------------------------------- utils ---------------------------------- */
const isBrowser = typeof window !== "undefined";
const genId = () =>
  Math.random().toString(36).slice(2) + Date.now().toString(36);
const nowIso = () => new Date().toISOString();
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const minutes = (n) => n * 60 * 1000;

async function safeImport(path) {
  try {
    const mod = await import(path);
    return mod?.default ?? mod;
  } catch {
    return null;
  }
}

function humanList(items, conj = "and") {
  const a = (items || []).filter(Boolean);
  if (a.length <= 1) return a[0] ?? "";
  if (a.length === 2) return `${a[0]} ${conj} ${a[1]}`;
  return `${a.slice(0, -1).join(", ")}, ${conj} ${a.at(-1)}`;
}

function uniq(arr) {
  return Array.from(new Set((arr || []).filter(Boolean)));
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
          `[CookingSessionEngine:${label}] retry ${i + 1}/${tries} failed`,
          e
        );
      }
    }
  }
  throw lastErr;
}

/* ---------------------------- events (with fallbacks) ---------------------------- */
let EVT = {
  COOKING_ENGINE_READY: "cooking.engine.ready",
  COOKING_SESSION_DRAFT: "cooking.session.draft",
  COOKING_SESSION_DRAFT_READY: "cooking.session.draft.ready", // persisted + ready for runners
  COOKING_SESSION_SCHEDULED: "cooking.session.scheduled",
  COOKING_SESSION_BLOCKED: "cooking.session.blocked",
  COOKING_SESSION_RUN_START: "cooking.session.run.start",
  COOKING_SESSION_RUN_FINISH: "cooking.session.run.finish",
  COOKING_FAVORITE_SAVED: "cooking.favorite.saved",
  COOKING_PLAN_SAVED: "cooking.plan.saved",
  COOKING_PLAN_FROM_INVENTORY: "cooking.plan.fromInventory",
  COOKING_PLAN_FROM_GARDEN: "cooking.plan.fromGarden",
  COOKING_PLAN_FROM_ANIMALS: "cooking.plan.fromAnimals",
  // cross-domain nudges
  CALENDAR_SUGGEST_ADD: "calendar.suggest.add",
  INVENTORY_RESERVE_SUGGEST: "inventory.reserve.suggest",
  INVENTORY_PICKLIST_SUGGEST: "inventory.picklist.suggest",
  MEALS_NEEDS_UPDATE: "meals.needs.update",
  CLEANING_SESSION_SUGGEST: "cleaning.session.suggest",
  SCT_PRICE_NUDGE: "scancomparetrust.price.nudge",
  SCT_COUPON_NUDGE: "scancomparetrust.coupon.nudge",
  SCT_SAFETY_ALERT: "scancomparetrust.safety.alert",

  // ✅ Nutrition chain events (canonical)
  NUTRITION_TARGETS_APPLIED: "nutrition.targets.applied",
  MEALPLAN_DRAFT_UPDATED: "mealplan.draft.updated",
  INVENTORY_SHORTAGE_DETECTED: "inventory.shortage.detected",
  GROCERY_DRAFT_GENERATED: "grocery.draft.generated",
  SESSION_DRAFT_CREATED: "session.draft.created",
  SESSION_STARTED: "session.started",
};

(async () => {
  const cat = await safeImport(
    "@/features/scan-compare-trust/automation/events.catalog.js"
  );
  if (cat?.EVENTS) EVT = { ...EVT, ...cat.EVENTS };
})();

/* ------------------------------ Soft eventBus ------------------------------ */
/**
 * SSA repo has had both:
 *  - "@/services/events/eventBus"
 *  - "@/services/eventBus"
 * We soft-import and provide a tiny wrapper.
 */
let SSA_EVENTBUS = { emit: () => {}, on: () => () => {} };
let _eventBusResolved = false;
function getEventBus() {
  if (_eventBusResolved) return SSA_EVENTBUS;

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
        SSA_EVENTBUS = eb;
        break;
      }
    } catch {}
  }

  _eventBusResolved = true;
  return SSA_EVENTBUS;
}

function emitBus(type, data) {
  const eb = getEventBus();
  try {
    eb.emit({
      type,
      ts: nowIso(),
      source: "CookingSessionEngine",
      data,
    });
  } catch (e) {
    if (import.meta?.env?.DEV)
      console.warn("[CookingSessionEngine] eventBus.emit failed", type, e);
  }
}

/* -------------------------- tiny domain knowledge -------------------------- */
// heuristic stage library for common cooking steps
const STAGES = {
  prep: (r) => ({
    type: "prep",
    title: `Prep — ${r.title}`,
    est: clamp((r.servings || 4) * 2, 5, 25),
    station: "prep",
  }),
  chop: (r) => ({
    type: "chop",
    title: `Chop — ${r.title}`,
    est: clamp(r.ingredients?.length || 6, 5, 20),
    station: "prep",
  }),
  marinate: (r) => ({
    type: "marinate",
    title: `Marinate — ${r.title}`,
    est: 5,
    station: "cold",
    leadMin: 120,
  }),
  defrost: (r) => ({
    type: "defrost",
    title: `Defrost — ${r.title}`,
    est: 2,
    station: "cold",
    leadMin: 360,
  }),
  cooktop: (r) => ({
    type: "cooktop",
    title: `Cook — ${r.title}`,
    est: clamp(r.cookTimeMin || 20, 8, 60),
    station: "range",
    noisy: true,
  }),
  oven: (r) => ({
    type: "oven",
    title: `Bake/Roast — ${r.title}`,
    est: clamp(r.bakeTimeMin || 25, 10, 90),
    station: "oven",
    noisy: false,
  }),
  pressure: (r) => ({
    type: "pressure",
    title: `Pressure cook — ${r.title}`,
    est: clamp(r.pressureTimeMin || 15, 10, 60),
    station: "appliance",
    noisy: true,
  }),
  label: (r) => ({
    type: "label",
    title: `Label & portion — ${r.title}`,
    est: 5,
    station: "prep",
  }),
  cleanup: (r) => ({
    type: "cleanup",
    title: `Cleanup station — ${r.title}`,
    est: 6,
    station: "sink",
  }),
};

// simple allergen and “unclean” (Torah) term checks (nudges only)
const SAFETY_RULES = {
  allergens: [/peanut/, /tree nut/, /shellfish/, /soy/, /gluten/, /dairy/],
  unclean: [/pork|bacon|ham|pepperoni|shrimp|catfish|lobster|crab/i],
};

function scanSafetyStrings(ingredients = []) {
  const lower = ingredients.map((x) => String(x).toLowerCase());
  const s = lower.join(" | ");
  const hits = [];
  for (const rx of SAFETY_RULES.allergens)
    if (rx.test(s)) hits.push("allergen");
  if (SAFETY_RULES.unclean.test(s)) hits.push("unclean");
  return Array.from(new Set(hits));
}

/* ------------------------------ defaults & presets ------------------------------ */
const DEFAULTS = {
  domain: "cooking",
  sessionTitle: "Cooking Session",
  quietHours: { start: 22, end: 7 }, // 10pm–7am
  sabbathGuard: true,
  consolidation: true,
  nbaHints: true,
  defaultDurationMin: 60,
  // RRULE helpers
  recurrencePresets: {
    DAILY_DINNER: "FREQ=DAILY;BYHOUR=17;BYMINUTE=30;BYSECOND=0",
    WEEKLY_BATCH_SUN: "FREQ=WEEKLY;BYDAY=SU;BYHOUR=13;BYMINUTE=0;BYSECOND=0",
    WEEKLY_SOUP_STEW: "FREQ=WEEKLY;BYDAY=WE;BYHOUR=17;BYMINUTE=30;BYSECOND=0",
  },
};

export default class CookingSessionEngine extends EventEmitter {
  constructor(options = {}) {
    super();
    this.opts = { ...DEFAULTS, ...options };
    this.ctx = {
      DexieDB: null,
      ServicesDb: null, // ✅ "@/services/db" module (optional)
      Automation: null,
      Guards: null,
      CalendarWriter: null,
      ProductResolver: null, // optional: map ingredients → inventory SKUs/products
      Stores: {}, // sessions, plans, favorites
    };
    this._init();
  }

  async _init() {
    // Original imports
    this.ctx.DexieDB = await safeImport("@/db");
    this.ctx.Automation = await safeImport("@/services/automation/runtime");
    this.ctx.Guards = await safeImport("@/services/session/guards");
    this.ctx.CalendarWriter = await safeImport(
      "@/services/calendar/CalendarWriter"
    );
    this.ctx.ProductResolver = await safeImport(
      "@/features/scan-compare-trust/services/products/ProductResolver"
    );

    // ✅ NEW: services/db (Dexie spine) — gives us saveSession + draft tables in v11
    this.ctx.ServicesDb = (await safeImport("@/services/db")) || null;

    try {
      const db = this.ctx.DexieDB?.default || this.ctx.DexieDB;
      this.ctx.Stores.sessions = db?.sessions;
      this.ctx.Stores.plans = db?.plans;
      this.ctx.Stores.favorites = db?.favorites;
    } catch (err) {
      console.warn(
        "[CookingSessionEngine] Dexie stores missing or not bound.",
        err
      );
    }

    this.emit("ready");
    this._emit(EVT.COOKING_ENGINE_READY, { at: nowIso() });

    // Also publish to eventBus (soft)
    emitBus(EVT.COOKING_ENGINE_READY, { at: nowIso() });
  }

  /* ------------------------------------------------------------------------ */
  /* Nutrition→MealPlan→Grocery→Session Draft Wiring                          */
  /* ------------------------------------------------------------------------ */

  /**
   * Data Contracts (reference)
   * - NutritionTargets:
   *   { id, householdId, personId, createdAt, appliedAt, source, macros, micros, constraints }
   * - MealPlanDraft:
   *   { id, householdId, personId, targetsId, createdAt, updatedAt, plan[], constraintsApplied }
   * - GroceryDraft:
   *   { id, householdId, personId, targetsId, mealPlanId, createdAt, updatedAt, items[], shortages[], edits }
   * - SessionDraft:
   *   { id, householdId, personId, targetsId, mealPlanId, groceryId, createdAt, updatedAt, recipeIds[], steps[], timers[] }
   *
   * Linkage:
   *   SessionDraft.targetsId -> NutritionTargetsHistory.id
   *   SessionDraft.mealPlanId -> MealPlanDrafts.id
   *   SessionDraft.groceryId -> GroceryDrafts.id
   */

  /**
   * loadSessionDraft
   * Loads a SessionDraft from Dexie draft tables (v11) using services/db spine if available.
   */
  async loadSessionDraft(sessionDraftId) {
    const sid = String(sessionDraftId || "");
    if (!sid) return null;

    const servicesDb = this.ctx.ServicesDb;
    const d = servicesDb?.db || servicesDb?.default || servicesDb;

    if (d?.sessionDrafts?.get) {
      try {
        return await d.sessionDrafts.get(sid);
      } catch {
        return null;
      }
    }

    // Fallback: try "@/db" (older layouts)
    const legacyDb = this.ctx.DexieDB?.default || this.ctx.DexieDB;
    if (legacyDb?.sessionDrafts?.get) {
      try {
        return await legacyDb.sessionDrafts.get(sid);
      } catch {
        return null;
      }
    }

    return null;
  }

  /**
   * resolveRecipesForDraft
   * Pulls recipes from recipeLibrary if present; otherwise returns minimal recipe shells.
   */
  async resolveRecipesForDraft(sessionDraft) {
    const recipeIds = Array.isArray(sessionDraft?.recipeIds)
      ? sessionDraft.recipeIds
      : [];
    if (!recipeIds.length) return [];

    const servicesDb = this.ctx.ServicesDb;
    const d = servicesDb?.db || servicesDb?.default || servicesDb;
    const lib =
      d?.recipeLibrary ||
      (this.ctx.DexieDB?.default || this.ctx.DexieDB)?.recipeLibrary;

    // If no library, return shells
    if (!lib?.get && !lib?.where) {
      return recipeIds.map((id) => ({
        id,
        title: `Recipe ${id}`,
        ingredients: [],
      }));
    }

    const out = [];
    for (const rid of recipeIds) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const r = await lib.get(String(rid));
        if (r) out.push(r);
        else out.push({ id: rid, title: `Recipe ${rid}`, ingredients: [] });
      } catch {
        out.push({ id: rid, title: `Recipe ${rid}`, ingredients: [] });
      }
    }
    return out;
  }

  /**
   * stepsFromRecipe
   * If a recipe has structured steps/timers, convert them into session steps + timers.
   * Supported recipe shapes (best-effort):
   *   recipe.steps: [{ text, durationSec?, durationMin?, timers?: [{label,durationSec}] }]
   *   recipe.instructions: string[] (fallback)
   */
  stepsFromRecipe(recipe) {
    const steps = [];
    const timers = [];

    const baseTitle = String(recipe?.title || "Recipe");
    const rSteps = Array.isArray(recipe?.steps) ? recipe.steps : null;
    const instr = Array.isArray(recipe?.instructions)
      ? recipe.instructions
      : null;

    const pushStep = (text, durationSec) => {
      const sid = genId();
      const s = {
        id: sid,
        text: text ? String(text) : `Cook — ${baseTitle}`,
      };
      if (Number.isFinite(durationSec) && durationSec > 0)
        s.durationSec = durationSec;
      steps.push(s);
      return sid;
    };

    if (rSteps && rSteps.length) {
      for (const st of rSteps) {
        const text = st?.text || st?.title || st?.instruction || "";
        const dur = Number.isFinite(st?.durationSec)
          ? Number(st.durationSec)
          : Number.isFinite(st?.durationMin)
          ? Number(st.durationMin) * 60
          : null;

        const stepId = pushStep(`[${baseTitle}] ${text}`, dur);

        const localTimers = Array.isArray(st?.timers) ? st.timers : [];
        for (const t of localTimers) {
          const dSec = Number.isFinite(t?.durationSec)
            ? Number(t.durationSec)
            : Number.isFinite(t?.durationMin)
            ? Number(t.durationMin) * 60
            : null;

          if (!Number.isFinite(dSec) || dSec <= 0) continue;
          timers.push({
            id: genId(),
            label: t?.label ? String(t.label) : `${baseTitle} timer`,
            durationSec: dSec,
            stepId,
          });
        }
      }
      return { steps, timers };
    }

    if (instr && instr.length) {
      for (const line of instr) {
        pushStep(`[${baseTitle}] ${line}`, null);
      }
      return { steps, timers };
    }

    // fallback: at least one step
    pushStep(`[${baseTitle}] Cook following your preferred method.`, null);
    return { steps, timers };
  }

  /**
   * buildDraftSessionFromSessionDraft
   * Converts a SessionDraft (from nutrition-driven chain) into a CookingSessionEngine session.
   *
   * Emits:
   *   session.draft.created  (canonical chain event)
   *   cooking.session.draft / cooking.session.draft.ready (existing engine events)
   */
  async buildDraftSessionFromSessionDraft(
    sessionDraft,
    { persist = true } = {}
  ) {
    if (!sessionDraft || typeof sessionDraft !== "object") {
      throw new Error(
        "buildDraftSessionFromSessionDraft requires a SessionDraft object"
      );
    }

    // Resolve recipe objects (best-effort)
    const recipes = await this.resolveRecipesForDraft(sessionDraft);

    // Build consolidated steps + timers (prefer recipe steps; fallback to stage tasks)
    const allSteps = [];
    const allTimers = [];
    for (const r of recipes) {
      const converted = this.stepsFromRecipe(r);
      allSteps.push(...(converted.steps || []));
      allTimers.push(...(converted.timers || []));
    }

    // Use existing buildDraftSession task pipeline (so your current UI continues to work)
    const draft = await this.buildDraftSession({
      date: nowIso(),
      batch: Boolean(sessionDraft?.batch),
      recipes: recipes.map((r) => ({
        id: r?.id,
        title: r?.title || "Recipe",
        ingredients: r?.ingredients || [],
        cookTimeMin: r?.cookTimeMin,
        bakeTimeMin: r?.bakeTimeMin,
        pressureTimeMin: r?.pressureTimeMin,
        servings: r?.servings,
      })),
      notes:
        sessionDraft?.notes ||
        "Generated from Nutrition → MealPlan → Grocery chain",
      adjacency: sessionDraft?.adjacency || null,
    });

    // Attach step/timer artifacts into meta so SessionRunner/CookingPlay can consume
    const enriched = {
      ...draft,
      meta: {
        ...(draft.meta || {}),
        // ✅ canonical linkage ids so downstream can trace chain
        householdId: sessionDraft.householdId || draft?.householdId,
        personId: sessionDraft.personId || draft?.personId,
        targetsId: sessionDraft.targetsId,
        mealPlanId: sessionDraft.mealPlanId,
        groceryId: sessionDraft.groceryId,
        sessionDraftId: sessionDraft.id,

        // ✅ actionable play artifacts
        steps: allSteps,
        timers: allTimers,
      },
    };

    const persisted = persist
      ? await this._persistDraftSession(enriched)
      : enriched;

    // Emit canonical chain event (session.draft.created)
    emitBus(EVT.SESSION_DRAFT_CREATED, {
      householdId: persisted?.meta?.householdId || sessionDraft.householdId,
      personId: persisted?.meta?.personId || sessionDraft.personId,
      targetsId: persisted?.meta?.targetsId || sessionDraft.targetsId,
      mealPlanId: persisted?.meta?.mealPlanId || sessionDraft.mealPlanId,
      groceryId: persisted?.meta?.groceryId || sessionDraft.groceryId,
      sessionDraftId: sessionDraft.id,
      cookingSessionId: persisted?.id,
      session: persisted,
    });

    return persisted;
  }

  /**
   * startFromSessionDraftId
   * Convenience: load SessionDraft -> build cooking session -> persist running session (if saveSession exists)
   * Emits:
   *   session.started (canonical chain event)
   */
  async startFromSessionDraftId(sessionDraftId) {
    const draft = await this.loadSessionDraft(sessionDraftId);
    if (!draft) throw new Error(`SessionDraft not found: ${sessionDraftId}`);

    // Build a cooking session doc from the draft
    const cookingSession = await this.buildDraftSessionFromSessionDraft(draft, {
      persist: true,
    });

    // Prefer services/db.saveSession (canonical stable sessionId routing)
    const servicesDb = this.ctx.ServicesDb;
    const saveSession =
      servicesDb?.saveSession || servicesDb?.default?.saveSession || null;

    let startedSession = cookingSession;

    if (typeof saveSession === "function") {
      startedSession = await withRetry(
        () =>
          saveSession({
            domain: "cooking",
            status: "running",
            startedAt: nowIso(),
            updatedAt: nowIso(),
            origin: "CookingSessionEngine.startFromSessionDraftId",
            // linkages
            householdId: draft.householdId,
            personId: draft.personId,
            targetsId: draft.targetsId,
            mealPlanId: draft.mealPlanId,
            groceryId: draft.groceryId,
            sessionDraftId: draft.id,
            // play artifacts (prefer meta.steps/meta.timers)
            steps: Array.isArray(cookingSession?.meta?.steps)
              ? cookingSession.meta.steps
              : [],
            timers: Array.isArray(cookingSession?.meta?.timers)
              ? cookingSession.meta.timers
              : [],
            recipeIds: Array.isArray(draft?.recipeIds) ? draft.recipeIds : [],
            // keep original engine structure too
            title: cookingSession.title,
            tasks: cookingSession.tasks,
            batch: cookingSession.batch,
            scheduledFor: nowIso(),
          }),
        { label: "saveSessionFromDraft" }
      );
    } else {
      // fallback: update stored session status
      startedSession = await this._persistSession({
        ...cookingSession,
        status: "running",
        startedAt: nowIso(),
      });
    }

    // Emit canonical chain event
    emitBus(EVT.SESSION_STARTED, {
      householdId: draft.householdId,
      personId: draft.personId,
      targetsId: draft.targetsId,
      mealPlanId: draft.mealPlanId,
      groceryId: draft.groceryId,
      sessionDraftId: draft.id,
      session: startedSession,
    });

    // Also emit legacy engine event for existing listeners
    this._emit(EVT.COOKING_SESSION_RUN_START, {
      sessionId: startedSession?.sessionId || startedSession?.id,
      from: "sessionDraft",
      sessionDraftId: draft.id,
    });

    return startedSession;
  }

  /* ------------------------------------------------------------------------ */
  /* Session building                                                         */
  /* ------------------------------------------------------------------------ */

  /**
   * buildDraftSession
   * NOTE:
   *  - Builds a draft *and* attempts to persist it immediately so that shims,
   *    SessionRunner, and favorites can find it by id.
   *  - Emits:
   *      cooking.session.draft          (raw build)
   *      cooking.session.draft.ready   (after persistence)
   *
   * @param {Object} input
   *  - date: ISO string (defaults to now)
   *  - recurring: { rrule?: string } optional
   *  - recipes: array of { id?, title, ingredients[], cookTimeMin?, bakeTimeMin?, servings? }
   *  - batch: boolean (enables staging/label tasks)
   *  - notes: string
   *  - adjacency: { source: 'garden'|'animals', hints?: {...} } optional
   */
  async buildDraftSession(input = {}) {
    const id = genId();
    const startedAt = nowIso();
    const {
      date = startedAt,
      recurring = null,
      recipes = [],
      batch = false,
      notes = "",
      adjacency = null,
    } = input;

    const tasks = [];
    const stationHints = new Set();
    const safetyHits = [];

    // Expand recipes into stage tasks
    for (const r of recipes) {
      const ings = r?.ingredients || [];
      const safety = scanSafetyStrings(ings);
      if (safety.length) safetyHits.push({ recipe: r.title, safety });

      // naive stage decomposition (can be replaced with Integrated Task Parser)
      tasks.push(
        this._task({ recipe: r.title, ...STAGES.prep(r) }),
        this._task({ recipe: r.title, ...STAGES.chop(r) })
      );

      // defrost/marinate heuristics if meats present
      const s = ings.map(String).join(" | ").toLowerCase();
      if (/(chicken|beef|lamb|goat|turkey)/.test(s)) {
        tasks.push(this._task({ recipe: r.title, ...STAGES.defrost(r) }));
        if (/marinat|tandoori|jerk|adobo|bulgogi|shawarma|bbq/.test(s)) {
          tasks.push(this._task({ recipe: r.title, ...STAGES.marinate(r) }));
        }
      }

      // choose a main heat stage
      if (/bake|roast|sheet pan|casserole/.test(s) || r.bakeTimeMin) {
        tasks.push(this._task({ recipe: r.title, ...STAGES.oven(r) }));
        stationHints.add("oven");
      } else if (/pressure|instant pot|ip /.test(s) || r.pressureTimeMin) {
        tasks.push(this._task({ recipe: r.title, ...STAGES.pressure(r) }));
        stationHints.add("appliance");
      } else {
        tasks.push(this._task({ recipe: r.title, ...STAGES.cooktop(r) }));
        stationHints.add("range");
      }

      if (batch) {
        tasks.push(this._task({ recipe: r.title, ...STAGES.label(r) }));
      }

      tasks.push(this._task({ recipe: r.title, ...STAGES.cleanup(r) }));
    }

    // Adjacency add-ons (garden/animals)
    const adjTasks = await this._adjacencyToTasks(adjacency);
    tasks.push(...adjTasks);

    // Consolidate similar tasks (by station|type)
    const consolidated = this.opts.consolidation
      ? this.consolidateTasks(tasks)
      : tasks;
    const stamped = this._stampTaskSchedule(consolidated, date);

    let session = {
      id,
      domain: this.opts.domain,
      title: this._buildTitle({ recipes, batch, stationHints, adjacency }),
      status: "draft",
      createdAt: startedAt,
      scheduledFor: date,
      recurring, // { rrule } | null
      batch,
      recipes: recipes.map((r) => ({ id: r.id, title: r.title })),
      adjacency,
      notes,
      tasks: stamped,
      estMinutes: stamped.reduce((a, t) => a + (t.estMinutes || 0), 0),
      meta: {
        version: 2,
        stationHints: Array.from(stationHints),
        safetyHits,
      },
    };

    // Emit draft pre-persist (for very lightweight listeners)
    this._emit(EVT.COOKING_SESSION_DRAFT, { session });

    // Persist draft so shims / SessionRunner & pages can find it by id
    session = await this._persistDraftSession(session);

    // Emit "ready" for UI + shims
    this._emit(EVT.COOKING_SESSION_DRAFT_READY, { session });

    // Nudges after we know the session is stable
    this._nudgeScanCompareTrust(recipes, safetyHits);
    this._emitCrossDomainHints({ session, recipes });

    return session;
  }

  _buildTitle({
    recipes = [],
    batch = false,
    stationHints = new Set(),
    adjacency,
  }) {
    const names = recipes.slice(0, 3).map((r) => r.title);
    const more = recipes.length > 3 ? ` +${recipes.length - 3}` : "";
    const stations = stationHints.size
      ? ` • ${humanList(Array.from(stationHints))}`
      : "";
    const adj = adjacency?.source ? ` (with ${adjacency.source})` : "";
    return `${batch ? "Batch: " : ""}${names.join(
      " • "
    )}${more}${stations}${adj}`;
  }

  async _adjacencyToTasks(adjacency) {
    if (!adjacency?.source) return [];
    const src = adjacency.source.toLowerCase();
    const tasks = [];

    if (src === "garden") {
      tasks.push(
        this._task({
          type: "produce-rinse",
          title: "Rinse & spin greens",
          estMinutes: 6,
          station: "sink",
        }),
        this._task({
          type: "produce-chop",
          title: "Chop garden veg for mise",
          estMinutes: 10,
          station: "prep",
        })
      );
    }

    if (src === "animals") {
      tasks.push(
        this._task({
          type: "butchery-thaw",
          title: "Thaw packaged cuts (safe method)",
          estMinutes: 2,
          station: "cold",
          leadMin: 360,
        }),
        this._task({
          type: "stock-broth",
          title: "Start stock/broth from bones",
          estMinutes: 10,
          station: "range",
          noisy: false,
        })
      );
    }

    return tasks;
  }

  _task({
    type = "general",
    title = "Task",
    estMinutes = 5,
    station = "prep",
    priority = "normal",
    recipe = null,
    noisy = false,
    leadMin = 0, // minutes required BEFORE session start (defrost/marinade)
  }) {
    return {
      id: genId(),
      type,
      title,
      estMinutes,
      station,
      priority,
      recipe,
      noisy,
      leadMin,
      done: false,
      scheduledFor: null, // set later
      sequence: null, // set later
    };
  }

  consolidateTasks(tasks = []) {
    const key = (t) => [t.station || "prep", t.type].join("|");
    const map = new Map();
    for (const t of tasks) {
      const k = key(t);
      if (!map.has(k)) {
        map.set(k, {
          ...t,
          mergedCount: 1,
          recipes: t.recipe ? [t.recipe] : [],
        });
      } else {
        const cur = map.get(k);
        cur.estMinutes = clamp(
          (cur.estMinutes || 0) + (t.estMinutes || 0),
          1,
          240
        );
        cur.mergedCount += 1;
        if (t.recipe) cur.recipes = uniq([...(cur.recipes || []), t.recipe]);
        cur.title = this._mergeTitles(cur.title, t.title);
        cur.leadMin = Math.max(cur.leadMin || 0, t.leadMin || 0);
        map.set(k, cur);
      }
    }
    return [...map.values()];
  }

  _mergeTitles(a = "", b = "") {
    const parts = Array.from(
      new Set(
        [a, b]
          .join(" | ")
          .split("|")
          .map((s) => s.trim())
          .filter(Boolean)
      )
    );
    const merged = parts.slice(0, 3).join(" | ");
    return merged.length > 120 ? `${merged.slice(0, 117)}...` : merged;
  }

  _stampTaskSchedule(tasks, dateISO) {
    return tasks
      .map((t, i) => ({
        ...t,
        scheduledFor: dateISO,
        sequence: i + 1,
      }))
      .sort((a, b) => (a.sequence || 0) - (b.sequence || 0));
  }

  /* ------------------------------------------------------------------------ */
  /* Guards + Scheduling                                                      */
  /* ------------------------------------------------------------------------ */

  async guardSession(session) {
    const reasons = [];
    let ok = true;

    // quiet hours (block noisy tasks like blender/pressure cook late night)
    if (this.opts.quietHours) {
      const date = new Date(session.scheduledFor || Date.now());
      const h = date.getHours();
      const { start, end } = this.opts.quietHours;
      const isQuiet =
        start > end ? h >= start || h < end : h >= start && h < end;
      const hasNoisy = session.tasks?.some((t) => t.noisy);
      if (isQuiet && hasNoisy) {
        ok = false;
        reasons.push("quiet-hours-noisy");
      }
    }

    // sabbath guard
    if (this.opts.sabbathGuard && this.ctx.Guards?.isSabbath) {
      try {
        if (await this.ctx.Guards.isSabbath(new Date(session.scheduledFor))) {
          ok = false;
          reasons.push("sabbath");
        }
      } catch {
        /* ignore */
      }
    }

    // lead-time guard (defrost/marinade tasks require prior hours)
    const leadNeeded = (session.tasks || []).reduce(
      (m, t) => Math.max(m, t.leadMin || 0),
      0
    );
    if (leadNeeded > 0) {
      const start = new Date(session.scheduledFor || Date.now()).getTime();
      const earliest = Date.now() + leadNeeded * 60 * 1000;
      if (earliest > start) {
        ok = false;
        reasons.push("lead-time");
      }
    }

    return { ok, reasons };
  }

  async scheduleSession(session, { writeToCalendar = false } = {}) {
    // Ensure per-task dates & updated totals
    const draft =
      session?.tasks?.length && session.tasks[0]?.scheduledFor
        ? { ...session }
        : {
            ...session,
            tasks: this._stampTaskSchedule(
              session.tasks || [],
              session.scheduledFor
            ),
          };
    draft.estMinutes = (draft.tasks || []).reduce(
      (a, t) => a + (t.estMinutes || 0),
      0
    );

    // Persist
    const persisted = await this._persistSession({
      ...draft,
      status: "scheduled",
    });

    // Guards
    const guard = await this.guardSession(persisted);
    if (!guard.ok) {
      this._emit(EVT.COOKING_SESSION_BLOCKED, {
        session: persisted,
        reasons: guard.reasons,
      });
      return {
        session: persisted,
        jobId: null,
        blocked: true,
        reasons: guard.reasons,
      };
    }

    // Automation runtime
    let jobId = null;
    if (this.ctx.Automation?.createJob) {
      try {
        const runPrompt = {
          type: "cooking.session.run",
          sessionId: persisted.id,
          title: persisted.title,
          domain: persisted.domain,
        };
        if (persisted.recurring?.rrule) {
          jobId = await this.ctx.Automation.createJob({
            title: `Cooking • ${persisted.title}`,
            prompt: runPrompt,
            schedule: {
              rrule: persisted.recurring.rrule,
              tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
            },
          });
        } else {
          jobId = await this.ctx.Automation.createJob({
            title: `Cooking • ${persisted.title}`,
            prompt: runPrompt,
            startsAt: persisted.scheduledFor,
          });
        }
      } catch (err) {
        console.warn(
          "[CookingSessionEngine] automation createJob failed:",
          err
        );
      }
    }

    // Calendar write (optional)
    if (writeToCalendar && this.ctx.CalendarWriter?.createEvent) {
      try {
        await this.ctx.CalendarWriter.createEvent({
          title: `Cooking: ${persisted.title}`,
          start: persisted.scheduledFor,
          durationMin: Math.max(15, persisted.estMinutes || 60),
          notes: this.toSpeechBrief(persisted),
          tags: ["cooking", "session"],
        });
        this._emit(EVT.CALENDAR_SUGGEST_ADD, {
          title: `Cooking: ${persisted.title}`,
          at: persisted.scheduledFor,
        });
      } catch (err) {
        console.warn("[CookingSessionEngine] calendar write failed:", err);
      }
    }

    this._emit(EVT.COOKING_SESSION_SCHEDULED, { session: persisted, jobId });
    return { session: persisted, jobId, blocked: false, reasons: [] };
  }

  /* ------------------------------------------------------------------------ */
  /* Persistence + Favorites                                                  */
  /* ------------------------------------------------------------------------ */

  async _persistSession(session) {
    const db = this.ctx.DexieDB?.default || this.ctx.DexieDB;
    const doc = {
      ...session,
      updatedAt: nowIso(),
    };

    if (!doc.createdAt) {
      doc.createdAt = nowIso();
    }

    if (db?.sessions?.put) {
      await db.sessions.put(doc);
    }

    return doc;
  }

  async _persistDraftSession(session) {
    // Helper used by buildDraftSession so the "draft ready" event always points
    // at something you can fetch from Dexie.
    const withStatus = {
      ...session,
      status: session.status || "draft",
    };
    return this._persistSession(withStatus);
  }

  async saveAsFavoriteSession(session, label = "") {
    const db = this.ctx.DexieDB?.default || this.ctx.DexieDB;
    const fav = {
      id: genId(),
      type: "session",
      domain: this.opts.domain,
      createdAt: nowIso(),
      label: label || session.title,
      payload: session,
      userOwned: true,
    };
    if (db?.favorites?.put) await db.favorites.put(fav);
    this._emit(EVT.COOKING_FAVORITE_SAVED, { favorite: fav });
    return fav;
  }

  async savePlanTemplate(plan, label = "") {
    const db = this.ctx.DexieDB?.default || this.ctx.DexieDB;
    const doc = {
      id: genId(),
      type: "plan-template",
      domain: this.opts.domain,
      createdAt: nowIso(),
      label: label || plan?.title || "Cooking Plan",
      payload: plan,
      userOwned: true,
    };
    if (db?.plans?.put) await db.plans.put(doc);
    this._emit(EVT.COOKING_PLAN_SAVED, { plan: doc });
    return doc;
  }

  /* ------------------------------------------------------------------------ */
  /* Reverse generation                                                       */
  /* ------------------------------------------------------------------------ */

  /**
   * generateFromInventory
   * Build a lightweight plan from inventory & user preferences (macro goals later).
   * @param {Object} opts
   *  - inventoryItems: [{ name, qty, unit, tags[] }]
   *  - hints: { style?: 'soups'|'stews'|'grill'|'bake', batch?: boolean }
   */
  async generateFromInventory({ inventoryItems = [], hints = {} } = {}) {
    const recipes = await this._proposeRecipesFromInventory(
      inventoryItems,
      hints
    );
    const tasks = [];
    for (const r of recipes) {
      tasks.push(this._task({ recipe: r.title, ...STAGES.prep(r) }));
      tasks.push(this._task({ recipe: r.title, ...STAGES.chop(r) }));
      if (/roast|bake|sheet/.test((r.title || "").toLowerCase())) {
        tasks.push(this._task({ recipe: r.title, ...STAGES.oven(r) }));
      } else {
        tasks.push(this._task({ recipe: r.title, ...STAGES.cooktop(r) }));
      }
      if (hints.batch)
        tasks.push(this._task({ recipe: r.title, ...STAGES.label(r) }));
      tasks.push(this._task({ recipe: r.title, ...STAGES.cleanup(r) }));
    }

    const stamped = this._stampTaskSchedule(tasks, nowIso());
    const plan = {
      id: genId(),
      domain: this.opts.domain,
      title: "Cooking Plan from Inventory",
      createdAt: nowIso(),
      tasks: stamped,
      meta: {
        inventoryCount: inventoryItems.length,
        hints,
        recipes: recipes.map((r) => r.title),
      },
    };

    this._emit(EVT.COOKING_PLAN_FROM_INVENTORY, { plan });
    this._emitInventoryPicklist(recipes);
    return plan;
  }

  /**
   * generateFromGardenHarvest
   * @param {Object} opts
   *  - harvest: [{ item, qty, unit }]
   */
  async generateFromGardenHarvest({ harvest = [] } = {}) {
    const recipes = this._quickRecipesForHarvest(harvest);
    const stamped = this._stampTaskSchedule(
      recipes.flatMap((r) => [
        this._task({ recipe: r.title, ...STAGES.prep(r) }),
        this._task({ recipe: r.title, ...STAGES.chop(r) }),
        this._task({ recipe: r.title, ...STAGES.cooktop(r) }),
        this._task({ recipe: r.title, ...STAGES.cleanup(r) }),
      ]),
      nowIso()
    );
    const plan = {
      id: genId(),
      domain: this.opts.domain,
      title: "Cooking Plan from Garden Harvest",
      createdAt: nowIso(),
      tasks: stamped,
      meta: { harvest },
    };
    this._emit(EVT.COOKING_PLAN_FROM_GARDEN, { plan });
    return plan;
  }

  /**
   * generateFromAnimalsProcessing
   * @param {Object} opts
   *  - cuts: [{ name: 'chicken thighs', lbs: 5 }, ...]
   */
  async generateFromAnimalsProcessing({ cuts = [] } = {}) {
    const recipes = this._quickRecipesForCuts(cuts);
    const stamped = this._stampTaskSchedule(
      recipes.flatMap((r) => [
        this._task({ recipe: r.title, ...STAGES.defrost(r) }),
        this._task({ recipe: r.title, ...STAGES.marinate(r) }),
        this._task({ recipe: r.title, ...STAGES.cooktop(r) }),
        this._task({ recipe: r.title, ...STAGES.label(r) }),
        this._task({ recipe: r.title, ...STAGES.cleanup(r) }),
      ]),
      nowIso()
    );
    const plan = {
      id: genId(),
      domain: this.opts.domain,
      title: "Cooking Plan from Animal Cuts",
      createdAt: nowIso(),
      tasks: stamped,
      meta: { cuts },
    };
    this._emit(EVT.COOKING_PLAN_FROM_ANIMALS, { plan });
    return plan;
  }

  /* ------------------------------ Nudges + Voice ------------------------------ */

  _nudgeScanCompareTrust(recipes, safetyHits) {
    // safety alerts
    for (const hit of safetyHits) {
      if (hit.safety.includes("unclean")) {
        this._emit(EVT.SCT_SAFETY_ALERT, {
          recipe: hit.recipe,
          reason: "unclean",
        });
      } else if (hit.safety.includes("allergen")) {
        this._emit(EVT.SCT_SAFETY_ALERT, {
          recipe: hit.recipe,
          reason: "allergen",
        });
      }
    }
    // simple price/coupon nudges (defer to your SCT services)
    const items = uniq(
      recipes.flatMap((r) =>
        (r.ingredients || []).map((x) => String(x).toLowerCase())
      )
    );
    if (items.length) {
      this._emit(EVT.SCT_PRICE_NUDGE, { items, source: "cooking.draft" });
      this._emit(EVT.SCT_COUPON_NUDGE, { items, source: "cooking.draft" });
    }
  }

  _emitInventoryPicklist(recipes) {
    const items = uniq(recipes.flatMap((r) => r.ingredients || []));
    if (!items.length) return;
    this._emit(EVT.INVENTORY_PICKLIST_SUGGEST, {
      domain: "cooking",
      items,
      reason: "Pick items for session from pantry/freezer",
    });
  }

  _emitCrossDomainHints({ session, recipes }) {
    // Cleaning: post-cook cleanup session suggestion
    this._emit(EVT.CLEANING_SESSION_SUGGEST, {
      reason: "Post-cook cleanup",
      suggestedTasks: ["Degrease range", "Run dishwasher", "Disinfect handles"],
      scheduledFor: session.scheduledFor,
    });

    // Meals: notify that plan/session exists
    this._emit(EVT.MEALS_NEEDS_UPDATE, {
      source: "cooking.session",
      recipes: recipes.map((r) => r.title),
    });

    // Inventory: reserve core perishables (eggs, dairy) + defrost reminder
    const lower = recipes.flatMap((r) =>
      (r.ingredients || []).map((x) => String(x).toLowerCase())
    );
    const reserve = [];
    if (lower.some((x) => /egg/.test(x))) reserve.push("Eggs");
    if (lower.some((x) => /milk|cream|cheese|yogurt/.test(x)))
      reserve.push("Dairy items");
    if (lower.some((x) => /chicken|beef|lamb|goat|turkey/.test(x)))
      reserve.push("Meat (defrost)");
    if (reserve.length) {
      this._emit(EVT.INVENTORY_RESERVE_SUGGEST, {
        domain: "cooking",
        items: uniq(reserve),
        reason: "Reserve perishables / defrost",
      });
    }
  }

  toSpeechBrief(session) {
    const titles = uniq((session.tasks || []).map((t) => t.recipe))
      .filter(Boolean)
      .slice(0, 3);
    const majors = (session.tasks || [])
      .sort((a, b) => (b.estMinutes || 0) - (a.estMinutes || 0))
      .slice(0, 3)
      .map((t) => t.title);
    return [
      `${session.title} scheduled.`,
      titles.length ? `Recipes: ${humanList(titles)}.` : "",
      majors.length ? `Top tasks: ${humanList(majors)}.` : "",
      `About ${Math.round((session.estMinutes || 60) / 5) * 5} minutes.`,
    ]
      .filter(Boolean)
      .join(" ");
  }

  nextBestAction(session) {
    const needsDefrost = session.tasks?.some((t) => t.type === "defrost");
    if (needsDefrost) {
      return {
        label: "Start safe defrost",
        actions: [
          "Move proteins to fridge tray",
          "Set timer reminders",
          "Check drip pans",
        ],
      };
    }
    const usesOven = session.tasks?.some((t) => t.station === "oven");
    if (usesOven) {
      return {
        label: "Stage oven workflow",
        actions: ["Preheat oven", "Line sheet pans", "Rotate racks mid-way"],
      };
    }
    return {
      label: "Set up prep station",
      actions: ["Clear counter", "Pull knives/boards", "Group mise by recipe"],
    };
  }

  /* ------------------------------------------------------------------------ */
  /* Runner                                                                   */
  /* ------------------------------------------------------------------------ */

  async runSession(sessionId) {
    const Runner = await safeImport("@/services/session/SessionRunner");
    if (Runner?.run) {
      return Runner.run({ domain: this.opts.domain, sessionId });
    }
    // fallback simulation
    this._emit(EVT.COOKING_SESSION_RUN_START, { sessionId });
    await new Promise((r) => setTimeout(r, minutes(0.2)));
    this._emit(EVT.COOKING_SESSION_RUN_FINISH, { sessionId });
    return { ok: true };
  }

  /* ------------------------------------------------------------------------ */
  /* Helpers                                                                  */
  /* ------------------------------------------------------------------------ */

  buildRecurring(presetKey) {
    const rrule = this.opts.recurrencePresets?.[presetKey];
    return rrule ? { rrule } : null;
  }

  async _proposeRecipesFromInventory(inventoryItems = [], hints = {}) {
    // Very lightweight matcher; swap with RecipeRecommender service when ready
    const items = inventoryItems.map((i) => String(i.name).toLowerCase());
    const picks = [];

    const has = (kw) => items.some((x) => x.includes(kw));
    if (has("chicken") && has("rice"))
      picks.push({
        title: "One-Pan Chicken & Rice",
        ingredients: ["chicken", "rice", "onion"],
      });
    if (has("ground beef") && has("tomato"))
      picks.push({
        title: "Skillet Beef & Tomatoes",
        ingredients: ["ground beef", "tomato", "garlic"],
      });
    if (has("beans") && has("onion"))
      picks.push({
        title: "Hearty Bean Stew",
        ingredients: ["beans", "onion", "carrot"],
      });
    if (has("flour") && has("eggs"))
      picks.push({
        title: "Quick Flatbreads",
        ingredients: ["flour", "eggs", "oil"],
      });

    // style/batch hints
    if (hints.style === "soups" || hints.style === "stews") {
      picks.push({
        title: "Garden Minestrone",
        ingredients: ["beans", "tomato", "zucchini"],
      });
    }
    if (!picks.length)
      picks.push({
        title: "Pantry Pasta",
        ingredients: ["pasta", "oil", "garlic"],
      });
    return picks.slice(0, 5);
  }

  _quickRecipesForHarvest(harvest = []) {
    const items = harvest.map((h) => String(h.item).toLowerCase());
    const picks = [];
    if (items.includes("tomato"))
      picks.push({
        title: "Sheet-Pan Roasted Tomatoes",
        ingredients: ["tomato", "oil", "salt"],
        bakeTimeMin: 25,
      });
    if (items.includes("zucchini"))
      picks.push({
        title: "Sautéed Zucchini & Onions",
        ingredients: ["zucchini", "onion"],
      });
    if (items.includes("greens"))
      picks.push({
        title: "Garlicky Greens",
        ingredients: ["greens", "garlic"],
      });
    if (!picks.length)
      picks.push({
        title: "Garden Stir-Fry",
        ingredients: ["mixed veg", "oil", "soy (optional)"],
      });
    return picks.slice(0, 4);
  }

  _quickRecipesForCuts(cuts = []) {
    const names = cuts.map((c) => String(c.name).toLowerCase());
    const picks = [];
    if (names.some((n) => /thigh|chicken/.test(n)))
      picks.push({
        title: "Marinated Chicken Thighs",
        ingredients: ["chicken thighs", "spices"],
      });
    if (names.some((n) => /beef stew|chuck|round/.test(n)))
      picks.push({
        title: "Beef Stew",
        ingredients: ["beef", "potatoes", "carrots"],
        pressureTimeMin: 30,
      });
    if (names.some((n) => /lamb/.test(n)))
      picks.push({
        title: "Herbed Lamb Chops",
        ingredients: ["lamb", "herbs"],
      });
    if (names.some((n) => /goat/.test(n)))
      picks.push({
        title: "Goat Curry",
        ingredients: ["goat", "spices"],
      });
    if (!picks.length)
      picks.push({
        title: "Mixed Meat Stir-Fry",
        ingredients: ["meat", "veg"],
      });
    return picks.slice(0, 4);
  }

  _emit(type, detail = {}) {
    try {
      // ✅ Also emit to SSA eventBus (soft) so pages refresh without reload
      emitBus(type, detail);

      if (isBrowser) {
        window.dispatchEvent(new CustomEvent(type, { detail }));
        const bus = window.__suka?.eventBus;
        if (bus?.emit) bus.emit(type, detail);
      }
    } catch (err) {
      console.warn("[CookingSessionEngine] emit warn:", err);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Example usage (commented for discoverability)                              */
/* -------------------------------------------------------------------------- */
/*
const engine = new CookingSessionEngine();

// 1) Draft from recipes
const draft = await engine.buildDraftSession({
  date: new Date().toISOString(),
  batch: true,
  recipes: [
    { title: "Sheet-Pan Chicken", ingredients: ["chicken", "potatoes", "onion"], bakeTimeMin: 35 },
    { title: "Minestrone", ingredients: ["beans", "tomato", "zucchini"], cookTimeMin: 30 },
  ],
  adjacency: { source: "garden" },
});

// 2) Schedule (one-time)
const result = await engine.scheduleSession(draft, { writeToCalendar: true });

// 3) Favorite (user-owned)
await engine.saveAsFavoriteSession(result.session, "Sunday Batch");

// 4) Recurring helper
const recurring = engine.buildRecurring("WEEKLY_BATCH_SUN");

// 5) Reverse: Inventory → plan
const invPlan = await engine.generateFromInventory({
  inventoryItems: [{ name: "chicken breast" }, { name: "rice" }, { name: "beans" }],
  hints: { batch: true, style: "stews" },
});

// 6) Reverse: Garden harvest → plan
const gardenPlan = await engine.generateFromGardenHarvest({ harvest: [{ item: "tomato" }, { item: "greens" }] });

// 7) Reverse: Animals cuts → plan
const animalPlan = await engine.generateFromAnimalsProcessing({ cuts: [{ name: "chicken thighs", lbs: 6 }] });

// 8) NBA
const nba = engine.nextBestAction(result.session);

// 9) NEW: Start cooking from nutrition-driven SessionDraft
const started = await engine.startFromSessionDraftId("sessdraft_...");
*/
