// File: C:\Users\larho\suka-smart-assistant\src\services\MealPlanService.js
/**
 * MealPlanService (SSA)
 * -----------------------------------------------------------------------------
 * Purpose
 *  - Deterministic, offline-first meal planning service that supports:
 *      • "fixed calendar rhythm" that mimics randomness (non-AI)
 *      • constraints & preferences (diet modes, meats, dislikes, sabbath/quiet)
 *      • rotating recipes + ability to pin/force meals
 *      • soup dinner + soup & sandwich lunch rhythm without overwhelm
 *      • integration hooks for inventory/storehouse and batch cooking sessions
 *      • exports for hub sync / calendar / sessions
 *
 * This service is intentionally "logic-first" and "data-driven":
 *  - Inputs: templates, recipes, user prefs, time window, constraints
 *  - Output: a plan (days -> meals -> entries) + shopping hints + session hints
 *
 * No Node imports. Browser-safe for Vite builds.
 *
 * Recommended integration (optional)
 *  - src/services/db.js exports { db } (Dexie)
 *  - src/store/MealPrefsStore.js or src/hooks/useMealPrefs.js (pref accessor)
 *  - src/services/StorehouseService.js for inventory availability and refill
 *  - src/services/calendar/CalendarManager.js for event creation
 *  - src/services/dashboard/DashboardLog.js for KPI logging
 *  - eventBus emit: "mealplan.updated"
 *
 * Note
 *  - This is not a full nutrition engine; it produces "nutrient intent hints"
 *    (macro style) and leaves detailed scoring to Nutrition module.
 */

const SOURCE = "services.MealPlanService";

/* -----------------------------------------------------------------------------
 * Optional deps (safe)
 * -------------------------------------------------------------------------- */

let db = null;
try {
  // eslint-disable-next-line import/no-unresolved
  const mod = await import("./db.js").catch(() => null);
  db = mod?.db || mod?.default?.db || mod?.default || null;
} catch {
  db = null;
}

let StorehouseService = null;
try {
  const mod = await import("./StorehouseService.js").catch(() => null);
  StorehouseService = mod?.default || mod?.StorehouseService || null;
} catch {
  StorehouseService = null;
}

let DashboardLog = null;
try {
  const mod = await import("./dashboard/DashboardLog.js").catch(() => null);
  DashboardLog = mod?.default || mod?.DashboardLog || null;
} catch {
  DashboardLog = null;
}

let CalendarManager = null;
try {
  const mod = await import("./calendar/CalendarManager.js").catch(() => null);
  CalendarManager = mod?.default || mod?.CalendarManager || null;
} catch {
  CalendarManager = null;
}

let bus = null;
try {
  const mod =
    (await import("./events/eventBus.js").catch(() => null)) ||
    (await import("./automation/eventBus.js").catch(() => null));
  bus = mod?.eventBus || mod?.default || mod || null;
} catch {
  bus = null;
}

let CookPlanTemplates = null;
try {
  const mod = await import("../libraries/CookPlanTemplates.js").catch(
    () => null
  );
  CookPlanTemplates = mod?.CookPlanTemplates || mod?.default || null;
} catch {
  CookPlanTemplates = null;
}

/* -----------------------------------------------------------------------------
 * Utils
 * -------------------------------------------------------------------------- */

const isObj = (x) => x && typeof x === "object" && !Array.isArray(x);
const safeObj = (x) => (isObj(x) ? x : {});
const safeArr = (x) => (Array.isArray(x) ? x : []);
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const nowISO = () => new Date().toISOString();

const keyOf = (s) =>
  String(s || "")
    .trim()
    .toLowerCase()
    .replace(/[^\w]+/g, "_")
    .replace(/^_+|_+$/g, "");

function tryEmit(event, payload) {
  try {
    if (!bus) return;
    if (typeof bus.emit === "function") bus.emit(event, payload);
    else if (typeof bus.publish === "function") bus.publish(event, payload);
  } catch {
    /* no-op */
  }
}

function stableHash(str) {
  // small deterministic hash (non-crypto)
  const s = String(str || "");
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed) {
  let t = seed >>> 0;
  return function () {
    t += 0x6d2b79f5;
    let x = Math.imul(t ^ (t >>> 15), 1 | t);
    x ^= x + Math.imul(x ^ (x >>> 7), 61 | x);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function pickWeighted(rng, items, weightFn) {
  const list = safeArr(items);
  if (!list.length) return null;
  const weights = list.map((it) => Math.max(0, Number(weightFn?.(it)) || 0));
  const total = weights.reduce((a, b) => a + b, 0);
  if (!(total > 0)) {
    // fallback uniform
    return list[Math.floor(rng() * list.length)];
  }
  let roll = rng() * total;
  for (let i = 0; i < list.length; i++) {
    roll -= weights[i];
    if (roll <= 0) return list[i];
  }
  return list[list.length - 1];
}

function isoDateKey(d) {
  const dt = d instanceof Date ? d : new Date(d);
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, "0");
  const day = String(dt.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function addDays(date, n) {
  const d = date instanceof Date ? new Date(date) : new Date(date);
  d.setDate(d.getDate() + Number(n || 0));
  return d;
}

function weekdayShort(date) {
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][
    (date instanceof Date ? date : new Date(date)).getDay()
  ];
}

function timeISO(date, hh = 18, mm = 0) {
  const d = date instanceof Date ? new Date(date) : new Date(date);
  d.setHours(hh, mm, 0, 0);
  return d.toISOString();
}

/* -----------------------------------------------------------------------------
 * Storage (Dexie or localStorage fallback)
 * -------------------------------------------------------------------------- */

const LS_KEY = "ssa.mealplan.v1";

function lsRead() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return { plans: {}, pins: {}, history: {} };
    const parsed = JSON.parse(raw);
    return {
      plans: safeObj(parsed.plans),
      pins: safeObj(parsed.pins),
      history: safeObj(parsed.history),
    };
  } catch {
    return { plans: {}, pins: {}, history: {} };
  }
}

function lsWrite(next) {
  try {
    localStorage.setItem(
      LS_KEY,
      JSON.stringify({
        plans: safeObj(next?.plans),
        pins: safeObj(next?.pins),
        history: safeObj(next?.history),
      })
    );
    return true;
  } catch {
    return false;
  }
}

function resolveMealPlanTable() {
  if (!db || !db.tables) return null;
  const names = ["meal_plans", "mealPlans", "plans", "mealplan"];
  const byName = new Map(safeArr(db.tables).map((t) => [t.name, t]));
  for (const n of names) if (byName.has(n)) return byName.get(n);
  return null;
}

const TABLE_MEALPLANS = resolveMealPlanTable();

/* -----------------------------------------------------------------------------
 * Core domain: "entries" and "plan"
 * -------------------------------------------------------------------------- */
/**
 * Meal Entry:
 *  {
 *    id,
 *    dayISO,               // YYYY-MM-DD
 *    mealSlot,             // breakfast | lunch | dinner
 *    kind,                 // template | recipe | leftover | manual
 *    title,
 *    templateId?, recipeId?,
 *    components: { protein?, veg?, starch?, sauce?, bread? } // high level
 *    tags: { ... }
 *    notes,
 *    locked: boolean       // pinned / forced
 *    sourceMeta: { seedKey, rngRoll, rule }
 *  }
 *
 * Meal Plan:
 *  {
 *    id,
 *    householdId,
 *    startISO,
 *    days,
 *    entries: { [dayISO]: { breakfast, lunch, dinner } }
 *    createdAt, updatedAt
 *    meta: { prefsSnapshot, seedKey, rulesUsed }
 *  }
 */

/* -----------------------------------------------------------------------------
 * Default rhythm rules (non-AI, deterministic)
 * -------------------------------------------------------------------------- */

const DEFAULT_RHYTHM = {
  // meal slots to plan
  slots: ["breakfast", "lunch", "dinner"],

  // fixed rhythm anchors by weekday
  // these are "roles" which map to template tags/rhythmRole
  weekdayAnchors: {
    Mon: { dinnerRole: "weeknight_anchor" },
    Tue: { dinnerRole: "soup_night" },
    Wed: { dinnerRole: "weeknight_anchor" },
    Thu: { dinnerRole: "soup_night" },
    Fri: { dinnerRole: "weeknight_anchor", sabbathHint: true },
    Sat: { dinnerRole: "prep_day_anchor", sabbathHint: true },
    Sun: { dinnerRole: "prep_day_anchor" },
  },

  // lunch default behavior
  lunchPolicy: {
    // when dinner role is soup_night, lunch becomes "soup & sandwich"
    soupSandwichFromSoupNight: true,
    // otherwise default to leftovers if available
    preferLeftovers: true,
  },

  // breakfast default behavior (can be overridden by prefs)
  breakfastPolicy: {
    defaultRole: "morning_anchor",
    allowBatchBreakfast: true,
  },

  // "mimic randomness" by rotating a deterministic seed per day/slot
  seedSalt: "ssa_mealplan_seed_v1",

  // avoid repeating same template too frequently (soft penalty)
  repetitionPenaltyWindowDays: 4,
  repetitionPenaltyWeight: 0.35, // reduce weight if recently used
};

/* -----------------------------------------------------------------------------
 * Preferences adapter
 * -------------------------------------------------------------------------- */

async function getPrefsSnapshot(options = {}) {
  // Attempt to read from MealPrefsStore if present.
  // We keep this very defensive because your store may change.
  const opts = safeObj(options);

  let prefs = {};
  try {
    const mod = await import("../store/MealPrefsStore.js").catch(() => null);
    const store = mod?.default || mod?.MealPrefsStore || null;

    // common patterns: store.get(), store.getState(), store.snapshot()
    if (store?.get) prefs = await store.get();
    else if (store?.getState) prefs = store.getState();
    else if (store?.snapshot) prefs = await store.snapshot();
  } catch {
    prefs = {};
  }

  // Optionally merge with PreferencesStore if you have it
  try {
    const mod = await import("../store/PreferencesStore.js").catch(() => null);
    const store = mod?.default || null;
    if (store?.get) {
      const more = await store.get();
      prefs = { ...safeObj(more), ...safeObj(prefs) };
    }
  } catch {
    /* ignore */
  }

  // Apply overrides provided by caller
  prefs = { ...safeObj(prefs), ...safeObj(opts.overridePrefs) };

  // Normalize a small subset used here
  const dietMode = String(prefs?.dietMode || prefs?.diet?.mode || "balanced");
  const sabbathAware = prefs?.sabbathAware !== false;
  const fixedMeats = safeArr(prefs?.fixedMeats || prefs?.meats || []).map(
    String
  );
  const dislikes = safeArr(
    prefs?.dislikes || prefs?.avoidIngredients || []
  ).map(String);
  const breakfastStyle = String(prefs?.breakfastStyle || "eggs_waffles_meat");
  const allowSoupDinner = prefs?.allowSoupDinner !== false;

  const householdId = String(
    prefs?.householdId || prefs?.household?.id || "primary"
  );

  return {
    raw: prefs,
    householdId,
    dietMode,
    sabbathAware,
    fixedMeats,
    dislikes,
    breakfastStyle,
    allowSoupDinner,
  };
}

/* -----------------------------------------------------------------------------
 * Template access / filtering
 * -------------------------------------------------------------------------- */

function allTemplates() {
  if (CookPlanTemplates && Array.isArray(CookPlanTemplates))
    return CookPlanTemplates;
  // Some modules export object; allow both
  if (CookPlanTemplates && typeof CookPlanTemplates === "object") {
    const maybe =
      CookPlanTemplates?.CookPlanTemplates || CookPlanTemplates?.default;
    if (Array.isArray(maybe)) return maybe;
  }
  return [];
}

function templateMatchesDiet(tpl, dietMode) {
  const tags = safeObj(tpl?.tags);
  const modes = safeArr(tags.dietModes).map(keyOf);
  if (!modes.length) return true;
  return modes.includes(keyOf(dietMode));
}

function templateMatchesRole(tpl, role) {
  const tags = safeObj(tpl?.tags);
  const roles = safeArr(tags.rhythmRole).map(keyOf);
  return roles.includes(keyOf(role));
}

/* -----------------------------------------------------------------------------
 * Pins / forced meals
 * -------------------------------------------------------------------------- */

async function getPins() {
  // pins shape:
  // { [dayISO]: { breakfast?, lunch?, dinner? } } where each slot is an Entry-like
  const snap = lsRead();
  return safeObj(snap.pins);
}

async function savePins(pins) {
  const snap = lsRead();
  lsWrite({ ...snap, pins: safeObj(pins) });
  return true;
}

/* -----------------------------------------------------------------------------
 * Recent history (for repetition penalty)
 * -------------------------------------------------------------------------- */

function getRecentHistory(windowDays = 4) {
  const snap = lsRead();
  const hist = safeObj(snap.history);
  const keys = Object.keys(hist)
    .sort()
    .slice(-windowDays * 3 - 10); // enough
  const used = [];
  for (const k of keys) used.push(...safeArr(hist[k]));
  return used;
}

function pushHistory(dayISO, usedTemplateIds = []) {
  const snap = lsRead();
  const hist = safeObj(snap.history);
  hist[dayISO] = safeArr(usedTemplateIds).map(String);
  lsWrite({ ...snap, history: hist });
}

/* -----------------------------------------------------------------------------
 * Planning engine (deterministic selection)
 * -------------------------------------------------------------------------- */

function buildSeedKey({ householdId, startISO, dayISO, slot, dietMode }) {
  return `${DEFAULT_RHYTHM.seedSalt}|hh:${householdId}|start:${startISO}|day:${dayISO}|slot:${slot}|diet:${dietMode}`;
}

function weightTemplate(tpl, ctx) {
  // Base weight: use template difficulty/cadence as minor influence
  const tags = safeObj(tpl?.tags);
  const diff = keyOf(tags.difficulty || "beginner");
  let w = 1;

  if (diff === "beginner") w *= 1.05;
  if (diff === "intermediate") w *= 1.0;
  if (diff === "advanced") w *= 0.9;

  // If role matches, boost
  if (ctx.role && templateMatchesRole(tpl, ctx.role)) w *= 2.0;

  // Diet match is enforced earlier, but keep small boost if explicitly included
  if (templateMatchesDiet(tpl, ctx.dietMode)) w *= 1.1;

  // Repetition penalty
  if (ctx.recentTemplateIds && ctx.recentTemplateIds.includes(String(tpl.id))) {
    w *= DEFAULT_RHYTHM.repetitionPenaltyWeight;
  }

  // Soup night gating
  if (ctx.role === "soup_night" && ctx.allowSoupDinner === false) {
    w *= 0; // block
  }

  return w;
}

function makeEntryFromTemplate(tpl, ctx) {
  const id = `mp_${ctx.dayISO}_${ctx.slot}_${keyOf(tpl.id)}_${ctx.roll.toFixed(
    5
  )}`;
  return {
    id,
    dayISO: ctx.dayISO,
    mealSlot: ctx.slot,
    kind: "template",
    title: tpl.name,
    templateId: tpl.id,
    recipeId: null,
    components: {},
    tags: {
      ...safeObj(tpl.tags),
      plannedBy: "MealPlanService",
    },
    notes: tpl.description || "",
    locked: false,
    sourceMeta: {
      seedKey: ctx.seedKey,
      rngRoll: ctx.roll,
      rule: ctx.rule || null,
    },
  };
}

function makeLeftoverEntry(ctx, fromMeal = "dinner") {
  const id = `mp_${ctx.dayISO}_${ctx.slot}_leftover_${fromMeal}`;
  return {
    id,
    dayISO: ctx.dayISO,
    mealSlot: ctx.slot,
    kind: "leftover",
    title: `Leftovers (${fromMeal})`,
    templateId: null,
    recipeId: null,
    components: {},
    tags: { plannedBy: "MealPlanService", leftoverFrom: fromMeal },
    notes:
      "Use packaged leftovers. If none available, swap in a quick template.",
    locked: false,
    sourceMeta: {
      seedKey: ctx.seedKey,
      rngRoll: ctx.roll,
      rule: "leftovers_policy",
    },
  };
}

function makeSoupSandwichLunch(ctx) {
  const id = `mp_${ctx.dayISO}_lunch_soup_sandwich`;
  return {
    id,
    dayISO: ctx.dayISO,
    mealSlot: "lunch",
    kind: "template",
    title: "Soup & Sandwich Lunch",
    templateId: "soup_dinner_and_sandwich_lunch_rhythm",
    recipeId: null,
    components: { soup: "leftover_soup", sandwich: "simple" },
    tags: { plannedBy: "MealPlanService", rhythmRole: ["soup_sandwich_lunch"] },
    notes:
      "Use reserved soup portions from soup night + quick sandwich/wrap. Keep it simple.",
    locked: false,
    sourceMeta: {
      seedKey: ctx.seedKey,
      rngRoll: ctx.roll,
      rule: "soup_sandwich_policy",
    },
  };
}

/* -----------------------------------------------------------------------------
 * Persistence: plans
 * -------------------------------------------------------------------------- */

async function savePlan(plan) {
  const p = safeObj(plan);
  if (!p.id) throw new Error("MealPlanService.savePlan: missing plan.id");

  if (TABLE_MEALPLANS) {
    try {
      if (typeof TABLE_MEALPLANS.put === "function") {
        await TABLE_MEALPLANS.put(p);
        return p;
      }
    } catch {
      // fall through
    }
  }

  const snap = lsRead();
  const plans = safeObj(snap.plans);
  plans[p.id] = p;
  lsWrite({ ...snap, plans });
  return p;
}

async function readPlan(planId) {
  const id = String(planId || "");
  if (!id) return null;

  if (TABLE_MEALPLANS) {
    try {
      if (typeof TABLE_MEALPLANS.get === "function") {
        return await TABLE_MEALPLANS.get(id);
      }
    } catch {
      /* ignore */
    }
  }

  const snap = lsRead();
  return safeObj(snap.plans)[id] || null;
}

/* -----------------------------------------------------------------------------
 * Public service
 * -------------------------------------------------------------------------- */

const MealPlanService = {
  /**
   * Generate a meal plan.
   * options:
   *  - startDate: Date | ISO | YYYY-MM-DD (default today)
   *  - days: number (default 7)
   *  - includeSlots: ["breakfast","lunch","dinner"] (default all)
   *  - rhythm: override DEFAULT_RHYTHM
   *  - overridePrefs: partial prefs to merge
   *  - pins: optional pins object (otherwise uses stored pins)
   *  - persist: boolean (default true)
   */
  async generate(options = {}) {
    const opts = safeObj(options);
    const startDate = opts.startDate ? new Date(opts.startDate) : new Date();
    const days = clamp(Number(opts.days) || 7, 1, 31);
    const startISO = isoDateKey(startDate);
    const includeSlots = safeArr(opts.includeSlots).length
      ? safeArr(opts.includeSlots)
      : DEFAULT_RHYTHM.slots;
    const rhythm = { ...DEFAULT_RHYTHM, ...safeObj(opts.rhythm) };

    const prefSnap = await getPrefsSnapshot({
      overridePrefs: opts.overridePrefs,
    });
    const householdId = prefSnap.householdId;
    const dietMode = prefSnap.dietMode;

    const templates = allTemplates().filter((t) =>
      templateMatchesDiet(t, dietMode)
    );

    // Load pins
    const pins = opts.pins ? safeObj(opts.pins) : await getPins();

    const recent = getRecentHistory(rhythm.repetitionPenaltyWindowDays);
    const planId = `mealplan_${householdId}_${startISO}_${days}_${keyOf(
      dietMode
    )}`;

    const entriesByDay = {};
    const rulesUsed = [];

    for (let i = 0; i < days; i++) {
      const day = addDays(startDate, i);
      const dayISO = isoDateKey(day);
      const dow = weekdayShort(day);

      entriesByDay[dayISO] = entriesByDay[dayISO] || {};

      const anchor = safeObj(rhythm.weekdayAnchors[dow] || {});
      const dinnerRole = anchor.dinnerRole || null;

      // Determine whether yesterday was soup night (for lunch policy)
      const yesterdayISO = isoDateKey(addDays(day, -1));
      const yAnchor = safeObj(
        rhythm.weekdayAnchors[weekdayShort(addDays(day, -1))] || {}
      );
      const yesterdayDinnerRole = yAnchor.dinnerRole || null;

      for (const slot of includeSlots) {
        // Apply pins first
        const pin = safeObj(pins[dayISO] || {})[slot];
        if (pin) {
          entriesByDay[dayISO][slot] = {
            ...safeObj(pin),
            dayISO,
            mealSlot: slot,
            locked: true,
          };
          continue;
        }

        const seedKey = buildSeedKey({
          householdId,
          startISO,
          dayISO,
          slot,
          dietMode,
        });
        const rng = mulberry32(stableHash(seedKey));
        const roll = rng();

        // Lunch policy: soup & sandwich after soup night
        if (
          slot === "lunch" &&
          rhythm.lunchPolicy?.soupSandwichFromSoupNight &&
          keyOf(yesterdayDinnerRole) === "soup_night"
        ) {
          entriesByDay[dayISO][slot] = makeSoupSandwichLunch({
            dayISO,
            slot,
            seedKey,
            roll,
          });
          rulesUsed.push("lunch.soup_sandwich_from_soup_night");
          continue;
        }

        // Lunch policy: leftovers
        if (slot === "lunch" && rhythm.lunchPolicy?.preferLeftovers) {
          // Set lunch to leftovers; UI/engine can swap if none
          entriesByDay[dayISO][slot] = makeLeftoverEntry({
            dayISO,
            slot,
            seedKey,
            roll,
          });
          rulesUsed.push("lunch.prefer_leftovers");
          continue;
        }

        // Breakfast: use breakfast role template (if available)
        if (slot === "breakfast") {
          const role = rhythm.breakfastPolicy?.defaultRole || "morning_anchor";
          const ctx = {
            dayISO,
            slot,
            dietMode,
            role,
            allowSoupDinner: prefSnap.allowSoupDinner,
            recentTemplateIds: recent,
            seedKey,
            roll,
            rule: "breakfast.default_role",
          };

          const pool = templates.filter((t) => templateMatchesRole(t, role));
          const pick = pickWeighted(rng, pool.length ? pool : templates, (t) =>
            weightTemplate(t, ctx)
          );
          if (pick) {
            entriesByDay[dayISO][slot] = makeEntryFromTemplate(pick, ctx);
            rulesUsed.push("breakfast.template_selection");
            continue;
          }
        }

        // Dinner: role-based template selection
        if (slot === "dinner" && dinnerRole) {
          const ctx = {
            dayISO,
            slot,
            dietMode,
            role: dinnerRole,
            allowSoupDinner: prefSnap.allowSoupDinner,
            recentTemplateIds: recent,
            seedKey,
            roll,
            rule: `dinner.role:${dinnerRole}`,
          };

          const pool = templates.filter((t) =>
            templateMatchesRole(t, dinnerRole)
          );
          const pick = pickWeighted(rng, pool.length ? pool : templates, (t) =>
            weightTemplate(t, ctx)
          );
          if (pick) {
            entriesByDay[dayISO][slot] = makeEntryFromTemplate(pick, ctx);
            rulesUsed.push(`dinner.template_selection:${dinnerRole}`);
            continue;
          }
        }

        // Generic fallback: pick any template
        const ctx = {
          dayISO,
          slot,
          dietMode,
          role: null,
          allowSoupDinner: prefSnap.allowSoupDinner,
          recentTemplateIds: recent,
          seedKey,
          roll,
          rule: "fallback.any_template",
        };
        const pick = pickWeighted(rng, templates, (t) =>
          weightTemplate(t, ctx)
        );
        entriesByDay[dayISO][slot] = pick
          ? makeEntryFromTemplate(pick, ctx)
          : makeLeftoverEntry(ctx, "dinner");
        rulesUsed.push("fallback.selection");
      }

      // Record history for repetition penalty (template ids used)
      const usedIds = [];
      for (const s of ["breakfast", "lunch", "dinner"]) {
        const e = entriesByDay[dayISO]?.[s];
        if (e?.templateId) usedIds.push(String(e.templateId));
      }
      pushHistory(dayISO, usedIds);
    }

    const plan = {
      id: planId,
      householdId,
      startISO,
      days,
      entries: entriesByDay,
      createdAt: nowISO(),
      updatedAt: nowISO(),
      meta: {
        seedSalt: rhythm.seedSalt,
        prefsSnapshot: prefSnap,
        rulesUsed: Array.from(new Set(rulesUsed)),
      },
      source: SOURCE,
    };

    // Attach storehouse hints (best-effort)
    const enrich = await MealPlanService.enrichWithStorehouseHints(plan).catch(
      () => null
    );
    const finalPlan = enrich || plan;

    // Persist
    if (opts.persist !== false) await savePlan(finalPlan);

    tryEmit("mealplan.updated", {
      planId: finalPlan.id,
      householdId,
      source: SOURCE,
    });

    // Dashboard KPI log
    try {
      if (DashboardLog?.log) {
        await DashboardLog.log({
          category: "Meal Plan",
          icon: "🍽️",
          message: `Meal plan generated: ${days} days starting ${startISO}`,
          time: new Date().toISOString(),
          meta: { planId: finalPlan.id, days, startISO, dietMode },
        });
      }
    } catch {
      /* non-fatal */
    }

    return finalPlan;
  },

  /**
   * Read a plan by id.
   */
  async get(planId) {
    return await readPlan(planId);
  },

  /**
   * Pin/force a meal entry for a given day + slot.
   * payload: { dayISO, slot, entry }
   */
  async pin(payload) {
    const p = safeObj(payload);
    const dayISO = String(p.dayISO || "");
    const slot = String(p.slot || "");
    const entry = safeObj(p.entry);

    if (!dayISO || !slot)
      throw new Error("MealPlanService.pin: missing dayISO or slot");

    const pins = await getPins();
    pins[dayISO] = pins[dayISO] || {};
    pins[dayISO][slot] = { ...entry, locked: true };

    await savePins(pins);
    tryEmit("mealplan.pins.updated", { dayISO, slot, source: SOURCE });
    return true;
  },

  /**
   * Unpin a meal entry.
   */
  async unpin(payload) {
    const p = safeObj(payload);
    const dayISO = String(p.dayISO || "");
    const slot = String(p.slot || "");
    if (!dayISO || !slot) return false;

    const pins = await getPins();
    if (pins[dayISO]?.[slot]) {
      delete pins[dayISO][slot];
      if (!Object.keys(pins[dayISO]).length) delete pins[dayISO];
      await savePins(pins);
      tryEmit("mealplan.pins.updated", { dayISO, slot, source: SOURCE });
      return true;
    }
    return false;
  },

  /**
   * Get stored pins.
   */
  async listPins() {
    return await getPins();
  },

  /**
   * Produce session hints for a plan:
   *  - suggests a Cooking Session blueprint per day (dinner-focused)
   *  - suggests a batch session if prep_day_anchor templates are present
   */
  buildSessionHints(plan) {
    const p = safeObj(plan);
    const entries = safeObj(p.entries);
    const hints = [];

    for (const dayISO of Object.keys(entries).sort()) {
      const dinner = entries[dayISO]?.dinner;
      if (!dinner) continue;

      const title = dinner.title || "Dinner";
      const templateId = dinner.templateId || null;

      hints.push({
        dayISO,
        type: "cooking",
        title: `Cooking: ${title}`,
        startTimeISO: timeISO(new Date(dayISO), 17, 0),
        templateId,
        tasksHint: templateId ? "use_template_tasks" : "manual",
      });
    }

    return hints;
  },

  /**
   * Enrich plan with storehouse-aware hints (best-effort).
   * Adds:
   *  - plan.meta.storehouse: { lowCount, refillSuggestionsPreview }
   *  - plan.meta.shoppingHints: from StorehouseService if available
   */
  async enrichWithStorehouseHints(plan) {
    if (!StorehouseService?.getSnapshot) return plan;

    const snap = await StorehouseService.getSnapshot({
      includeReservations: true,
    }).catch(() => null);
    if (!snap) return plan;

    const lowCount = Number(snap?.stats?.lowCount) || 0;
    const refill = await StorehouseService.getRefillSuggestions({
      mode: "target",
      limit: 15,
    }).catch(() => []);

    const enriched = {
      ...plan,
      meta: {
        ...safeObj(plan.meta),
        storehouse: {
          lowCount,
          totalSku: snap?.stats?.totalSku || null,
        },
        shoppingHints: {
          refillPreview: safeArr(refill).slice(0, 10),
        },
      },
      updatedAt: nowISO(),
    };

    return enriched;
  },

  /**
   * Optionally push the plan to Calendar (best-effort, if CalendarManager exists).
   * Creates events for dinners (and optionally batch sessions).
   *
   * options:
   *  - slots: ["dinner"] default
   *  - startHour: number default 17
   *  - durationMinutes: number default 60
   */
  async syncToCalendar(plan, options = {}) {
    if (!CalendarManager?.logEvent)
      return { ok: false, reason: "no_calendar_manager" };

    const p = safeObj(plan);
    const entries = safeObj(p.entries);
    const opts = safeObj(options);
    const slots = safeArr(opts.slots).length ? safeArr(opts.slots) : ["dinner"];
    const startHour = clamp(Number(opts.startHour) || 17, 0, 23);
    const dur = clamp(Number(opts.durationMinutes) || 60, 15, 240);

    const created = [];
    for (const dayISO of Object.keys(entries).sort()) {
      for (const slot of slots) {
        const e = entries[dayISO]?.[slot];
        if (!e) continue;

        const start = new Date(dayISO);
        start.setHours(startHour, 0, 0, 0);
        const end = new Date(start);
        end.setMinutes(end.getMinutes() + dur);

        try {
          const ref = await CalendarManager.logEvent({
            title: `Meal: ${e.title || slot}`,
            start: start.toISOString(),
            end: end.toISOString(),
            category: "mealplan",
            notes: e.notes || "",
            meta: {
              planId: p.id,
              dayISO,
              slot,
              templateId: e.templateId || null,
              recipeId: e.recipeId || null,
            },
          });
          created.push({ dayISO, slot, id: ref?.id || null });
        } catch {
          /* continue */
        }
      }
    }

    return { ok: true, createdCount: created.length, created };
  },

  /**
   * Build a compact export packet for hub sync.
   */
  exportPacket(plan) {
    const p = safeObj(plan);
    return {
      type: "mealplan",
      source: SOURCE,
      createdAt: nowISO(),
      plan: {
        id: p.id,
        householdId: p.householdId,
        startISO: p.startISO,
        days: p.days,
        entries: p.entries,
        meta: p.meta,
        updatedAt: p.updatedAt,
      },
    };
  },

  /**
   * Capabilities probe (for debugging).
   */
  capabilities() {
    return {
      source: SOURCE,
      hasDexieDb: !!db,
      hasMealPlanTable: !!TABLE_MEALPLANS,
      hasStorehouse: !!StorehouseService,
      hasCalendar: !!CalendarManager,
      hasDashboardLog: !!DashboardLog,
      hasEventBus: !!bus,
      templatesLoaded: allTemplates().length,
    };
  },
};

export default MealPlanService;
export { MealPlanService };
