// File: src/services/selectors/cookingSelectors.js
/**
 * cookingSelectors
 * -----------------------------------------------------------------------------
 * Production-ready selector layer for SSA cooking / meal workflows.
 *
 * What this selector layer provides
 *  - Browser-safe (no Node imports)
 *  - Dexie-backed querying with robust table resolution (schema drift tolerant)
 *  - High-signal query helpers for:
 *      • recipes
 *      • cooking sessions (batch sessions / session runner)
 *      • meal plans (days, meals, rotations)
 *      • prep tasks derived from recipes/sessions
 *      • KPIs for dashboards (today/this week, upcoming, overdue, completed)
 *  - liveQuery factories for reactive UI use
 *
 * Assumptions / Compatibility
 *  - SSA has Dexie db at: src/services/db.js
 *  - Your table names may differ; selectors attempt to resolve a best-fit table:
 *      recipes: recipes | recipeLibrary | recipe_library
 *      sessions: sessions | cooking_sessions | cookingSessions
 *      meal plans: mealPlans | meal_plans | plans
 *      tasks: tasks | prepTasks | prep_tasks | board_tasks
 *
 * Notes
 *  - This module is intentionally READ-ONLY. Writes belong in services.
 *  - If your volumes grow huge, replace in-memory filtering with indexed query plans.
 */

import db from "@/services/db";
import { liveQuery } from "dexie";

/* -----------------------------------------------------------------------------
 * Defaults / constants
 * -------------------------------------------------------------------------- */

const DEFAULTS = Object.freeze({
  limit: 100,
  offset: 0,
  sortBy: "updatedAt", // updatedAt | createdAt | name | date | status
  sortDir: "desc", // asc | desc
  now: () => Date.now(),
  // "Today" is local-time based. If you use Luxon elsewhere, keep selectors simple.
  dayStartMs: (nowMs) => {
    const d = new Date(nowMs);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  },
  dayEndMs: (nowMs) => {
    const d = new Date(nowMs);
    d.setHours(23, 59, 59, 999);
    return d.getTime();
  },
});

const TABLES = Object.freeze({
  recipes: [
    "recipes",
    "recipeLibrary",
    "recipe_library",
    "recipeVault",
    "recipe_vault",
  ],
  sessions: [
    "sessions",
    "cookingSessions",
    "cooking_sessions",
    "batchSessions",
    "batch_sessions",
  ],
  mealPlans: ["mealPlans", "meal_plans", "plans", "mealplan", "meal_plan"],
  tasks: ["tasks", "prepTasks", "prep_tasks", "boardTasks", "board_tasks"],
});

/* -----------------------------------------------------------------------------
 * Table resolution (schema drift tolerant)
 * -------------------------------------------------------------------------- */

/**
 * @param {any} dexieDb
 * @param {string[]} candidates
 * @param {(t:any)=>boolean} [predicate]
 * @returns {import("dexie").Table|null}
 */
function resolveTable(dexieDb, candidates, predicate) {
  if (!dexieDb) return null;

  for (const key of candidates || []) {
    const t = dexieDb[key];
    if (t && typeof t.toCollection === "function") return t;
  }

  // Fallback: scan Dexie tables for a name match
  try {
    const tables = dexieDb.tables || [];
    const byName = tables.find((t) =>
      candidates.some(
        (c) => String(t?.name || "").toLowerCase() === c.toLowerCase()
      )
    );
    if (byName) return byName;

    // If caller provided predicate, pick first matching table
    if (typeof predicate === "function") {
      const pick = tables.find(predicate);
      if (pick) return pick;
    }

    // Last resort: fuzzy match by keywords
    const keywords = candidates
      .map((c) => String(c).toLowerCase())
      .flatMap((c) => c.split(/[_\-]/g))
      .filter(Boolean);

    const fuzzy = tables.find((t) =>
      keywords.some((k) =>
        String(t?.name || "")
          .toLowerCase()
          .includes(k)
      )
    );
    return fuzzy || null;
  } catch {
    return null;
  }
}

function tableOrThrow(name, candidates) {
  const t = resolveTable(db, candidates);
  if (!t) {
    const known = (db?.tables || []).map((x) => x?.name).filter(Boolean);
    throw new Error(
      `cookingSelectors: Could not resolve table "${name}". Tried: ${candidates.join(
        ", "
      )}. Known: ${known.join(", ")}`
    );
  }
  return t;
}

function recipesTable() {
  return tableOrThrow("recipes", TABLES.recipes);
}
function sessionsTable() {
  return tableOrThrow("sessions", TABLES.sessions);
}
function mealPlansTable() {
  return tableOrThrow("mealPlans", TABLES.mealPlans);
}
function tasksTable() {
  return tableOrThrow("tasks", TABLES.tasks);
}

/* -----------------------------------------------------------------------------
 * Normalizers & safe accessors
 * -------------------------------------------------------------------------- */

function normalizeText(s) {
  return String(s || "")
    .toLowerCase()
    .trim();
}

function normalizeDateValue(v) {
  if (!v) return null;
  if (v instanceof Date) return v.getTime();
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const ms = Date.parse(String(v));
  return Number.isFinite(ms) ? ms : null;
}

function safeId(x) {
  return x?.id ?? x?._id ?? x?.uuid ?? x?.key ?? null;
}

function safeName(x) {
  return String(x?.name ?? x?.title ?? x?.label ?? "").trim();
}

function safeUpdatedAt(x) {
  return normalizeDateValue(
    x?.updatedAt ?? x?.updated_at ?? x?.lastUpdated ?? x?.last_updated
  );
}

function safeCreatedAt(x) {
  return normalizeDateValue(
    x?.createdAt ?? x?.created_at ?? x?.created ?? x?.createdOn
  );
}

function safeStatus(x) {
  return String(x?.status ?? x?.state ?? "").trim();
}

function safeTags(x) {
  return Array.isArray(x?.tags) ? x.tags : [];
}

function safeCuisine(x) {
  return String(x?.cuisine ?? x?.profile ?? "").trim();
}

function safeDomain(x) {
  return String(x?.domain ?? x?.type ?? "").trim();
}

function safePlannedFor(x) {
  return normalizeDateValue(
    x?.plannedFor ?? x?.planned_for ?? x?.date ?? x?.dayISO ?? x?.day
  );
}

function safeStartsAt(x) {
  return normalizeDateValue(
    x?.startsAt ?? x?.starts_at ?? x?.startAt ?? x?.start_at
  );
}

function safeEndsAt(x) {
  return normalizeDateValue(x?.endsAt ?? x?.ends_at ?? x?.endAt ?? x?.end_at);
}

function safeCompletedAt(x) {
  return normalizeDateValue(
    x?.completedAt ?? x?.completed_at ?? x?.doneAt ?? x?.done_at
  );
}

function safeRecipeIdsFromSession(session) {
  const arr =
    session?.recipeIds ??
    session?.recipe_ids ??
    session?.recipes ??
    session?.items ??
    session?.queue ??
    [];
  if (!Array.isArray(arr)) return [];
  return arr
    .map((r) =>
      typeof r === "string" || typeof r === "number"
        ? r
        : r?.id ?? r?._id ?? r?.recipeId ?? r?.recipe_id
    )
    .filter((x) => x != null);
}

function matchesArchived(x, includeArchived) {
  const archived = !!(
    x?.archived ??
    x?.isArchived ??
    x?.deleted ??
    x?.isDeleted
  );
  return includeArchived ? true : !archived;
}

function matchesTextQuery(x, q, extraFields = []) {
  const qq = normalizeText(q);
  if (!qq) return true;
  const parts = [
    safeName(x),
    safeCuisine(x),
    safeDomain(x),
    ...(safeTags(x) || []),
    ...(Array.isArray(extraFields) ? extraFields : []),
  ].filter(Boolean);
  return normalizeText(parts.join(" ")).includes(qq);
}

function sortByKey(items, sortBy, sortDir) {
  const dir = String(sortDir || "asc").toLowerCase() === "desc" ? -1 : 1;

  const getter = (() => {
    switch (sortBy) {
      case "createdAt":
        return (x) => safeCreatedAt(x) ?? 0;
      case "name":
        return (x) => normalizeText(safeName(x));
      case "date":
        return (x) => safePlannedFor(x) ?? safeStartsAt(x) ?? 0;
      case "status":
        return (x) => normalizeText(safeStatus(x));
      case "updatedAt":
      default:
        return (x) => safeUpdatedAt(x) ?? 0;
    }
  })();

  return [...(items || [])].sort((a, b) => {
    const av = getter(a);
    const bv = getter(b);
    if (av < bv) return -1 * dir;
    if (av > bv) return 1 * dir;
    // stable tiebreaker
    const an = normalizeText(safeName(a));
    const bn = normalizeText(safeName(b));
    if (an < bn) return -1 * dir;
    if (an > bn) return 1 * dir;
    return 0;
  });
}

function paginate(items, limit, offset) {
  const l = Math.max(0, Number(limit ?? DEFAULTS.limit) || 0);
  const o = Math.max(0, Number(offset ?? DEFAULTS.offset) || 0);
  if (!l) return { items: items.slice(o), total: items.length };
  return { items: items.slice(o, o + l), total: items.length };
}

/* -----------------------------------------------------------------------------
 * Recipe selectors
 * -------------------------------------------------------------------------- */

/**
 * Get recipe by ID.
 * @param {string|number} id
 */
export async function getRecipeById(id) {
  if (id == null) return null;
  return await recipesTable().get(id);
}

/**
 * List recipes with filters.
 * @param {object} opts
 * @param {string} [opts.query]
 * @param {string} [opts.cuisine]
 * @param {string[]} [opts.tags]
 * @param {boolean} [opts.includeArchived]
 * @param {number} [opts.limit]
 * @param {number} [opts.offset]
 * @param {string} [opts.sortBy]
 * @param {string} [opts.sortDir]
 */
export async function listRecipes(opts = {}) {
  const {
    query,
    cuisine,
    tags,
    includeArchived = false,
    limit = DEFAULTS.limit,
    offset = DEFAULTS.offset,
    sortBy = "name",
    sortDir = "asc",
  } = opts;

  const all = await recipesTable().toArray();

  const wantedTags = (tags || []).map(normalizeText).filter(Boolean);

  const filtered = all
    .filter((r) => matchesArchived(r, includeArchived))
    .filter((r) =>
      cuisine ? normalizeText(safeCuisine(r)) === normalizeText(cuisine) : true
    )
    .filter((r) => {
      if (!wantedTags.length) return true;
      const rt = (safeTags(r) || []).map(normalizeText);
      return wantedTags.every((t) => rt.includes(t));
    })
    .filter((r) =>
      matchesTextQuery(r, query, [
        r?.description,
        r?.notes,
        r?.summary,
        r?.source,
      ])
    );

  const sorted = sortByKey(filtered, sortBy, sortDir);
  return paginate(sorted, limit, offset);
}

/**
 * Get recipes by a set of ids (preserves input order best-effort).
 * @param {Array<string|number>} ids
 */
export async function getRecipesByIds(ids = []) {
  const list = (ids || []).filter((x) => x != null);
  if (!list.length) return [];
  const found = await recipesTable().bulkGet(list);
  // bulkGet preserves input order with undefined where missing
  return found.filter(Boolean);
}

/* -----------------------------------------------------------------------------
 * Cooking session selectors (SessionRunner / CookingSessionEngine)
 * -------------------------------------------------------------------------- */

/**
 * Get cooking session by ID.
 * @param {string|number} id
 */
export async function getCookingSessionById(id) {
  if (id == null) return null;
  return await sessionsTable().get(id);
}

/**
 * List cooking sessions with filters.
 * @param {object} opts
 * @param {string} [opts.query]
 * @param {string} [opts.status] - e.g. planned | active | paused | completed | canceled
 * @param {string} [opts.domain] - e.g. cooking
 * @param {boolean} [opts.includeArchived]
 * @param {number} [opts.limit]
 * @param {number} [opts.offset]
 * @param {string} [opts.sortBy] - updatedAt|createdAt|date|status|name
 * @param {string} [opts.sortDir]
 */
export async function listCookingSessions(opts = {}) {
  const {
    query,
    status,
    domain,
    includeArchived = false,
    limit = DEFAULTS.limit,
    offset = DEFAULTS.offset,
    sortBy = "updatedAt",
    sortDir = "desc",
  } = opts;

  const all = await sessionsTable().toArray();

  const filtered = all
    .filter((s) => matchesArchived(s, includeArchived))
    .filter((s) =>
      domain ? normalizeText(safeDomain(s)) === normalizeText(domain) : true
    )
    .filter((s) =>
      status ? normalizeText(safeStatus(s)) === normalizeText(status) : true
    )
    .filter((s) =>
      matchesTextQuery(s, query, [s?.notes, s?.summary, s?.intent, s?.title])
    );

  const sorted = sortByKey(
    filtered,
    sortBy === "date" ? "date" : sortBy,
    sortDir
  );
  return paginate(sorted, limit, offset);
}

/**
 * List sessions planned for "today".
 */
export async function listSessionsForToday(opts = {}) {
  const {
    includeArchived = false,
    status, // optional
    nowMs = DEFAULTS.now(),
    sortDir = "asc",
  } = opts;

  const start = DEFAULTS.dayStartMs(nowMs);
  const end = DEFAULTS.dayEndMs(nowMs);

  const all = await sessionsTable().toArray();
  const filtered = all
    .filter((s) => matchesArchived(s, includeArchived))
    .filter((s) =>
      status ? normalizeText(safeStatus(s)) === normalizeText(status) : true
    )
    .filter((s) => {
      const t = safePlannedFor(s) ?? safeStartsAt(s);
      if (!t) return false;
      return t >= start && t <= end;
    });

  return sortByKey(filtered, "date", sortDir);
}

/**
 * List active sessions (status in active|running|in_progress).
 */
export async function listActiveCookingSessions(opts = {}) {
  const {
    includeArchived = false,
    sortBy = "updatedAt",
    sortDir = "desc",
  } = opts;
  const activeSet = new Set([
    "active",
    "running",
    "in_progress",
    "inprogress",
    "started",
  ]);

  const all = await sessionsTable().toArray();
  const filtered = all
    .filter((s) => matchesArchived(s, includeArchived))
    .filter((s) => activeSet.has(normalizeText(safeStatus(s))));

  return sortByKey(filtered, sortBy, sortDir);
}

/**
 * For a given session, resolve its recipe records (if possible).
 * @param {string|number} sessionId
 * @returns {Promise<{session:any, recipeIds:Array<string|number>, recipes:any[]}>}
 */
export async function getSessionWithRecipes(sessionId) {
  const session = await getCookingSessionById(sessionId);
  if (!session) return { session: null, recipeIds: [], recipes: [] };

  const recipeIds = safeRecipeIdsFromSession(session);
  const recipes = await getRecipesByIds(recipeIds);

  return { session, recipeIds, recipes };
}

/* -----------------------------------------------------------------------------
 * Meal plan selectors
 * -------------------------------------------------------------------------- */

/**
 * Get meal plan by ID.
 * @param {string|number} id
 */
export async function getMealPlanById(id) {
  if (id == null) return null;
  return await mealPlansTable().get(id);
}

/**
 * List meal plans (high-level plan documents).
 * @param {object} opts
 * @param {string} [opts.query]
 * @param {boolean} [opts.includeArchived]
 * @param {number} [opts.limit]
 * @param {number} [opts.offset]
 * @param {string} [opts.sortBy]
 * @param {string} [opts.sortDir]
 */
export async function listMealPlans(opts = {}) {
  const {
    query,
    includeArchived = false,
    limit = DEFAULTS.limit,
    offset = DEFAULTS.offset,
    sortBy = "updatedAt",
    sortDir = "desc",
  } = opts;

  const all = await mealPlansTable().toArray();
  const filtered = all
    .filter((p) => matchesArchived(p, includeArchived))
    .filter((p) =>
      matchesTextQuery(p, query, [p?.notes, p?.summary, p?.title, p?.name])
    );

  const sorted = sortByKey(filtered, sortBy, sortDir);
  return paginate(sorted, limit, offset);
}

/**
 * Get meals planned for today across the "active" or latest plan.
 *
 * Strategy (best-effort):
 *  - If opts.planId provided, use that plan.
 *  - Else: pick the most recently updated plan.
 *  - Expect plan.days[] with date/dayISO and meals[] entries.
 *
 * @param {object} opts
 * @param {string|number} [opts.planId]
 * @param {number} [opts.nowMs]
 * @returns {Promise<{plan:any, day:any, meals:any[]}>}
 */
export async function getTodaysMeals(opts = {}) {
  const { planId, nowMs = DEFAULTS.now() } = opts;
  const start = DEFAULTS.dayStartMs(nowMs);
  const end = DEFAULTS.dayEndMs(nowMs);

  let plan = null;

  if (planId != null) plan = await getMealPlanById(planId);

  if (!plan) {
    const all = await mealPlansTable().toArray();
    const sorted = sortByKey(
      all.filter((p) => matchesArchived(p, false)),
      "updatedAt",
      "desc"
    );
    plan = sorted[0] || null;
  }

  if (!plan) return { plan: null, day: null, meals: [] };

  const days = Array.isArray(plan?.days) ? plan.days : [];
  const day =
    days.find((d) => {
      const t = normalizeDateValue(
        d?.date ?? d?.dayISO ?? d?.day ?? d?.isoDate
      );
      if (!t) return false;
      return t >= start && t <= end;
    }) || null;

  const meals = Array.isArray(day?.meals)
    ? day.meals
    : Array.isArray(day?.entries)
    ? day.entries
    : [];

  return { plan, day, meals };
}

/**
 * Extract recipe IDs referenced by today's meals (best-effort).
 * Useful for quick "cook now" / batch suggestions.
 */
export async function getTodaysMealRecipeIds(opts = {}) {
  const { meals } = await getTodaysMeals(opts);
  const ids = [];

  for (const m of meals || []) {
    const id = m?.recipeId ?? m?.recipe_id ?? m?.id;
    if (id != null) ids.push(id);
  }
  return Array.from(new Set(ids));
}

/* -----------------------------------------------------------------------------
 * Prep task selectors (optional; depends on your task board module)
 * -------------------------------------------------------------------------- */

/**
 * List prep tasks with filters.
 * @param {object} opts
 * @param {string} [opts.query]
 * @param {string} [opts.status] - todo|doing|done|blocked
 * @param {string} [opts.domain] - cooking
 * @param {string|number} [opts.sessionId]
 * @param {string|number} [opts.recipeId]
 * @param {boolean} [opts.includeArchived]
 * @param {number} [opts.limit]
 * @param {number} [opts.offset]
 * @param {string} [opts.sortBy]
 * @param {string} [opts.sortDir]
 */
export async function listPrepTasks(opts = {}) {
  const {
    query,
    status,
    domain,
    sessionId,
    recipeId,
    includeArchived = false,
    limit = DEFAULTS.limit,
    offset = DEFAULTS.offset,
    sortBy = "updatedAt",
    sortDir = "desc",
  } = opts;

  const all = await tasksTable().toArray();

  const filtered = all
    .filter((t) => matchesArchived(t, includeArchived))
    .filter((t) =>
      domain
        ? normalizeText(t?.domain ?? t?.type ?? "") === normalizeText(domain)
        : true
    )
    .filter((t) =>
      status
        ? normalizeText(t?.status ?? t?.state ?? "") === normalizeText(status)
        : true
    )
    .filter((t) =>
      sessionId != null
        ? String(t?.sessionId ?? t?.session_id ?? "") === String(sessionId)
        : true
    )
    .filter((t) =>
      recipeId != null
        ? String(t?.recipeId ?? t?.recipe_id ?? "") === String(recipeId)
        : true
    )
    .filter((t) =>
      matchesTextQuery(t, query, [t?.notes, t?.summary, t?.description])
    );

  const sorted = sortByKey(filtered, sortBy, sortDir);
  return paginate(sorted, limit, offset);
}

/**
 * List prep tasks due today (best-effort).
 */
export async function listPrepTasksDueToday(opts = {}) {
  const {
    nowMs = DEFAULTS.now(),
    includeArchived = false,
    sortDir = "asc",
  } = opts;

  const start = DEFAULTS.dayStartMs(nowMs);
  const end = DEFAULTS.dayEndMs(nowMs);

  const all = await tasksTable().toArray();

  const filtered = all
    .filter((t) => matchesArchived(t, includeArchived))
    .filter((t) => {
      const due = normalizeDateValue(
        t?.dueAt ?? t?.due_at ?? t?.due ?? t?.plannedFor ?? t?.planned_for
      );
      if (!due) return false;
      return due >= start && due <= end;
    })
    .filter(
      (t) =>
        normalizeText(t?.status ?? "") !== "done" &&
        normalizeText(t?.status ?? "") !== "completed"
    );

  return sortByKey(filtered, "date", sortDir);
}

/* -----------------------------------------------------------------------------
 * KPI selectors (dashboards)
 * -------------------------------------------------------------------------- */

/**
 * Cooking KPIs bundle — designed for home/dashboard cards.
 * @param {object} opts
 * @param {number} [opts.nowMs]
 */
export async function getCookingKPIs(opts = {}) {
  const nowMs = opts.nowMs ?? DEFAULTS.now();

  // Sessions
  const sessions = await sessionsTable().toArray();
  const sessionsActive = sessions.filter((s) => {
    const st = normalizeText(safeStatus(s));
    return [
      "active",
      "running",
      "in_progress",
      "inprogress",
      "started",
    ].includes(st);
  });
  const sessionsPlannedToday = await listSessionsForToday({ nowMs });

  // Meal plan
  const todaysMeals = await getTodaysMeals({ nowMs });

  // Prep tasks
  let prepDueToday = [];
  try {
    prepDueToday = await listPrepTasksDueToday({ nowMs });
  } catch {
    // tasks table may not exist in some deployments; tolerate
    prepDueToday = [];
  }

  // Derived: “recipes queued today”
  const recipeIdsFromSessionsToday = Array.from(
    new Set(
      (sessionsPlannedToday || [])
        .flatMap((s) => safeRecipeIdsFromSession(s))
        .filter((x) => x != null)
    )
  );

  return {
    generatedAt: nowMs,

    sessions: {
      total: sessions.length,
      activeCount: sessionsActive.length,
      plannedTodayCount: sessionsPlannedToday.length,
      plannedToday: sessionsPlannedToday,
      active: sessionsActive,
    },

    meals: {
      planId: safeId(todaysMeals.plan),
      mealsTodayCount: (todaysMeals.meals || []).length,
      day: todaysMeals.day,
      meals: todaysMeals.meals,
    },

    prep: {
      dueTodayCount: (prepDueToday || []).length,
      dueToday: prepDueToday,
    },

    queue: {
      recipeIdsPlannedToday: recipeIdsFromSessionsToday,
    },
  };
}

/* -----------------------------------------------------------------------------
 * Live selector factories (Dexie liveQuery)
 * -------------------------------------------------------------------------- */

/**
 * Use with dexie-react-hooks useLiveQuery, or manual subscription.
 * Example:
 *   const { items, total } = useLiveQuery(makeLiveRecipes({ query: "goat" }), [q], { items:[], total:0 })
 */

export function makeLiveRecipes(opts = {}) {
  return () => liveQuery(() => listRecipes(opts));
}

export function makeLiveCookingSessions(opts = {}) {
  return () => liveQuery(() => listCookingSessions(opts));
}

export function makeLiveTodaysMeals(opts = {}) {
  return () => liveQuery(() => getTodaysMeals(opts));
}

export function makeLiveCookingKPIs(opts = {}) {
  return () => liveQuery(() => getCookingKPIs(opts));
}

export function makeLivePrepTasks(opts = {}) {
  return () => liveQuery(() => listPrepTasks(opts));
}

/* -----------------------------------------------------------------------------
 * Convenience UI mapping helpers (pure functions; no DB)
 * -------------------------------------------------------------------------- */

/**
 * Convert a recipe record into a stable card model for UI components.
 */
export function toRecipeCardModel(recipe) {
  if (!recipe) return null;
  return {
    id: safeId(recipe),
    name: safeName(recipe),
    cuisine: safeCuisine(recipe),
    tags: safeTags(recipe),
    updatedAt: safeUpdatedAt(recipe),
    createdAt: safeCreatedAt(recipe),
    // Optional common fields
    servings: recipe?.servings ?? recipe?.yield ?? recipe?.portions ?? null,
    timeMinutes:
      recipe?.timeMinutes ?? recipe?.time_minutes ?? recipe?.totalTime ?? null,
    image: recipe?.image ?? recipe?.photo ?? null,
    source: recipe?.source ?? null,
  };
}

/**
 * Convert a session record into a stable card model.
 */
export function toCookingSessionCardModel(session) {
  if (!session) return null;
  return {
    id: safeId(session),
    title:
      safeName(session) ||
      String(session?.title || session?.intent || "Cooking Session"),
    status: safeStatus(session),
    plannedFor: safePlannedFor(session),
    startsAt: safeStartsAt(session),
    endsAt: safeEndsAt(session),
    completedAt: safeCompletedAt(session),
    recipeIds: safeRecipeIdsFromSession(session),
    updatedAt: safeUpdatedAt(session),
  };
}

/**
 * Compute a coarse status label for UI chips.
 */
export function computeCookingSessionStatus(session, nowMs = DEFAULTS.now()) {
  if (!session) return { status: "unknown", flags: [] };
  const flags = [];
  const st = normalizeText(safeStatus(session));

  const planned = safePlannedFor(session);
  const starts = safeStartsAt(session);
  const ends = safeEndsAt(session);
  const done = safeCompletedAt(session);

  if (done) flags.push("completed");
  if (st.includes("cancel")) flags.push("canceled");
  if (["active", "running", "in_progress", "started"].includes(st))
    flags.push("active");
  if (["paused", "hold"].some((k) => st.includes(k))) flags.push("paused");

  if (!done && planned && planned < nowMs - 2 * 60 * 60 * 1000)
    flags.push("overdue"); // 2h grace
  if (!done && planned && planned > nowMs) flags.push("upcoming");

  if (!done && ends && ends < nowMs) flags.push("past_end");

  const status = flags.includes("completed")
    ? "completed"
    : flags.includes("canceled")
    ? "canceled"
    : flags.includes("active")
    ? "active"
    : flags.includes("paused")
    ? "paused"
    : flags.includes("overdue")
    ? "overdue"
    : flags.includes("upcoming")
    ? "upcoming"
    : "planned";

  return { status, flags, meta: { planned, starts, ends } };
}

/* -----------------------------------------------------------------------------
 * Context selector (shim-facing)
 * -------------------------------------------------------------------------- */

/**
 * selectCookingContext(opts)
 * -----------------------------------------------------------------------------
 * Export expected by agent shims (e.g., mealBundleShim):
 *   import { selectCookingContext } from "@/services/selectors/cookingSelectors";
 *
 * This is a HIGH-SIGNAL, compact context bundle for reasoner prompts.
 * It intentionally avoids returning huge arrays by default.
 *
 * @param {object} opts
 * @param {number} [opts.nowMs]
 * @param {string|number} [opts.planId]
 * @param {boolean} [opts.includeLists] - if true, includes full today/active arrays
 * @returns {Promise<object>}
 */
export async function selectCookingContext(opts = {}) {
  const nowMs = opts.nowMs ?? DEFAULTS.now();
  const includeLists = !!opts.includeLists;

  // KPIs (already compact + useful)
  let kpis = null;
  try {
    kpis = await getCookingKPIs({ nowMs });
  } catch (e) {
    kpis = {
      generatedAt: nowMs,
      error: e?.message || "Failed to compute cooking KPIs.",
    };
  }

  // Today’s meals (compact)
  let todays = { plan: null, day: null, meals: [] };
  try {
    todays = await getTodaysMeals({ nowMs, planId: opts.planId });
  } catch {
    todays = { plan: null, day: null, meals: [] };
  }

  // Recipe ids referenced today (compact)
  let recipeIdsToday = [];
  try {
    recipeIdsToday = await getTodaysMealRecipeIds({
      nowMs,
      planId: opts.planId,
    });
  } catch {
    recipeIdsToday = [];
  }

  // Sessions summary (compact)
  let activeSessions = [];
  let plannedTodaySessions = [];
  try {
    activeSessions = await listActiveCookingSessions({
      includeArchived: false,
    });
  } catch {
    activeSessions = [];
  }
  try {
    plannedTodaySessions = await listSessionsForToday({
      nowMs,
      includeArchived: false,
    });
  } catch {
    plannedTodaySessions = [];
  }

  // Compact counts + bounded previews
  const sessionPreview = (arr) =>
    (arr || [])
      .slice(0, 10)
      .map((s) => toCookingSessionCardModel(s))
      .filter(Boolean);

  const mealPreview = (arr) =>
    (arr || []).slice(0, 10).map((m) => ({
      id: m?.id ?? null,
      type: m?.type ?? m?.mealType ?? null,
      title: String(m?.title ?? m?.name ?? m?.label ?? "").trim() || null,
      recipeId: m?.recipeId ?? m?.recipe_id ?? null,
      notes: (m?.notes || "").slice(0, 200) || null,
    }));

  return {
    nowMs,

    // Meal planning anchors
    todaysMeals: {
      planId: safeId(todays.plan),
      day: todays.day
        ? {
            date:
              normalizeDateValue(
                todays.day?.date ??
                  todays.day?.dayISO ??
                  todays.day?.day ??
                  todays.day?.isoDate
              ) ?? null,
            label:
              String(todays.day?.label ?? todays.day?.name ?? "").trim() ||
              null,
          }
        : null,
      mealsCount: (todays.meals || []).length,
      meals: includeLists ? todays.meals : mealPreview(todays.meals),
    },

    // Useful for bundling / cooking suggestions
    recipeIdsToday,

    // Session runner context
    sessions: {
      activeCount: (activeSessions || []).length,
      plannedTodayCount: (plannedTodaySessions || []).length,
      active: includeLists ? activeSessions : sessionPreview(activeSessions),
      plannedToday: includeLists
        ? plannedTodaySessions
        : sessionPreview(plannedTodaySessions),
    },

    // Dashboard bundle (already compact)
    kpis,
  };
}
