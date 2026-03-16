// File: C:\Users\larho\suka-smart-assistant\src\store\MealHistoryStore.js
/**
 * MealHistoryStore (SSA)
 * -----------------------------------------------------------------------------
 * Offline-first meal history + meal event log store.
 *
 * Goals
 *  - Capture what was actually eaten/prepared (not just planned)
 *  - Support dashboards, nutrition summaries, budget summaries, and habit loops
 *  - Safe in browser builds (no Node imports)
 *  - Dexie-backed when available; localStorage fallback when not
 *  - Event-driven: emits to eventBus + automation event bus (if present)
 *  - Schema tolerant: works with partial/unknown data shapes
 *
 * Concepts
 *  - "meal entry" = one recorded meal occurrence (breakfast/lunch/dinner/snack)
 *  - "meal event" = an action that happened (cooked session completed, imported receipt,
 *    leftovers stored, restaurant meal, etc.)
 *
 * Table strategy
 *  - Prefer Dexie tables if they exist:
 *      • meal_history (entries)
 *      • meal_events (events)
 *    If missing, we fall back to localStorage.
 *
 * Public API
 *  - hydrate()
 *  - getState() / subscribe()
 *  - addEntry(entry)
 *  - updateEntry(id, patch)
 *  - deleteEntry(id)
 *  - addEvent(event)
 *  - listEntries(query)
 *  - listEvents(query)
 *  - summarize(range)
 *  - clearAll()
 *
 * Notes
 *  - This store does not enforce nutrition math; it stores records that other
 *    services can aggregate (nutrition layer, budgeting layer, etc.)
 */

import db from "@/services/db";

/* -----------------------------------------------------------------------------
 * Optional deps (soft)
 * -------------------------------------------------------------------------- */

let eventBus = null;
try {
  const mod = await import("@/services/events/eventBus");
  eventBus = mod?.default ?? mod ?? null;
} catch {
  eventBus = null;
}

let autoBus = null;
try {
  const mod = await import("@/services/automation/eventBus.js");
  autoBus = mod?.default ?? mod ?? null;
} catch {
  autoBus = null;
}

let logger = null;
try {
  const mod = await import("@/utils/logger.js");
  logger = mod?.default ?? null;
} catch {
  logger = null;
}

/* -----------------------------------------------------------------------------
 * Constants
 * -------------------------------------------------------------------------- */

const SOURCE = "store.MealHistoryStore";

const LS_KEYS = {
  entries: "ssa.mealHistory.entries.v1",
  events: "ssa.mealHistory.events.v1",
  meta: "ssa.mealHistory.meta.v1",
};

const DEFAULT_STATE = {
  hydrated: false,
  dirty: false,
  lastUpdated: 0,
  error: null,

  counts: {
    entries: 0,
    events: 0,
  },
};

/* -----------------------------------------------------------------------------
 * Internal state
 * -------------------------------------------------------------------------- */

const state = { ...DEFAULT_STATE };
const subs = new Set();
let persistTimer = null;

/* -----------------------------------------------------------------------------
 * Helpers
 * -------------------------------------------------------------------------- */

function isObj(x) {
  return x && typeof x === "object" && !Array.isArray(x);
}
function safeObj(x) {
  return isObj(x) ? x : {};
}
function safeArr(x) {
  return Array.isArray(x) ? x : [];
}
function nowISO() {
  return new Date().toISOString();
}
function todayISO() {
  return new Date().toISOString().slice(0, 10);
}
function normalizeDateISO(x) {
  const s = String(x || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  if (!Number.isFinite(d.getTime())) return todayISO();
  return d.toISOString().slice(0, 10);
}
function normalizeTsISO(x) {
  if (!x) return nowISO();
  const d = new Date(x);
  if (!Number.isFinite(d.getTime())) return nowISO();
  return d.toISOString();
}
function createId(prefix = "mh") {
  return `${prefix}_${Date.now().toString(16)}_${Math.random()
    .toString(16)
    .slice(2)}`;
}
function clamp(n, a, b) {
  const v = Number(n);
  if (!Number.isFinite(v)) return a;
  return Math.max(a, Math.min(b, v));
}

function emit(name, payload) {
  try {
    eventBus?.emit?.(name, payload);
  } catch {
    // ignore
  }
  try {
    autoBus?.emit?.(name, payload);
  } catch {
    // ignore
  }
}

function notify() {
  const snap = getState();
  for (const fn of subs) {
    try {
      fn(snap);
    } catch {
      // ignore subscriber errors
    }
  }
}

function schedulePersist(delayMs = 250) {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    persistNow().catch(() => {});
  }, delayMs);
}

function logWarn(msg, meta) {
  try {
    logger?.warn?.(msg, meta, { source: SOURCE });
  } catch {
    // ignore
  }
}

/* -----------------------------------------------------------------------------
 * Table discovery
 * -------------------------------------------------------------------------- */

const ENTRY_TABLE_CANDIDATES = [
  "meal_history",
  "mealHistory",
  "meal_entries",
  "mealEntries",
];
const EVENT_TABLE_CANDIDATES = [
  "meal_events",
  "mealEvents",
  "meal_history_events",
  "mealHistoryEvents",
];

function resolveTable(nameList) {
  for (const n of nameList) {
    const t = db?.[n];
    if (t && typeof t.put === "function" && typeof t.get === "function")
      return t;
  }
  try {
    const tables = db?.tables || [];
    for (const n of nameList) {
      const hit = tables.find((t) => t?.name === n);
      if (hit) return hit;
    }
  } catch {
    // ignore
  }
  return null;
}

function entriesTable() {
  return resolveTable(ENTRY_TABLE_CANDIDATES);
}
function eventsTable() {
  return resolveTable(EVENT_TABLE_CANDIDATES);
}

/* -----------------------------------------------------------------------------
 * LocalStorage fallback
 * -------------------------------------------------------------------------- */

function loadLS(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function saveLS(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

/* -----------------------------------------------------------------------------
 * Normalization
 * -------------------------------------------------------------------------- */

/**
 * Normalize a meal entry.
 * Minimal recommended shape:
 *  {
 *    id, dateISO, atISO, mealType, title,
 *    recipes?, items?, servings?, notes?,
 *    sources?: { sessionId?, planId?, receiptId? }
 *  }
 */
function normalizeEntry(input) {
  const x = safeObj(input);

  const id = x.id || x.entryId || createId("meal");
  const dateISO = normalizeDateISO(x.dateISO || x.date || x.day || todayISO());
  const atISO = normalizeTsISO(
    x.atISO || x.timeISO || x.timestamp || x.at || `${dateISO}T12:00:00.000Z`
  );

  const mealType = String(
    x.mealType || x.type || x.meal || "meal"
  ).toLowerCase();
  const allowedTypes = ["breakfast", "lunch", "dinner", "snack", "meal"];
  const mealTypeNorm = allowedTypes.includes(mealType) ? mealType : "meal";

  const title =
    x.title ||
    x.name ||
    safeArr(x.recipes)[0]?.title ||
    safeArr(x.recipes)[0]?.name ||
    safeArr(x.items)[0]?.name ||
    safeArr(x.items)[0]?.label ||
    "Meal";

  const servings = x.servings ?? x.portions ?? x.count ?? null;
  const cost = x.cost ?? x.price ?? null;

  const recipes = safeArr(x.recipes);
  const items = safeArr(x.items);
  const nutrition = safeObj(x.nutrition); // optional macro totals etc.

  const sources = safeObj(x.sources || x.sourceRefs || {});
  const tags = safeArr(x.tags)
    .map((t) => String(t).trim())
    .filter(Boolean);

  return {
    id,
    dateISO,
    atISO,
    mealType: mealTypeNorm,
    title: String(title),
    servings: servings != null ? Number(servings) : null,
    cost: cost != null ? Number(cost) : null,
    recipes,
    items,
    nutrition,
    notes: x.notes != null ? String(x.notes) : "",
    leftovers: x.leftovers != null ? String(x.leftovers) : "",
    tags,
    sources: {
      sessionId: sources.sessionId || x.sessionId || null,
      planId: sources.planId || x.planId || null,
      receiptId: sources.receiptId || x.receiptId || null,
      importId: sources.importId || x.importId || null,
    },
    createdAt: normalizeTsISO(x.createdAt || x.createdISO || x.created),
    updatedAt: normalizeTsISO(
      x.updatedAt || x.updatedISO || x.updated || nowISO()
    ),
    meta: safeObj(x.meta),
  };
}

/**
 * Normalize a meal event.
 * Minimal recommended shape:
 *  { id, atISO, type, message, refs? }
 */
function normalizeEvent(input) {
  const x = safeObj(input);
  const id = x.id || x.eventId || createId("mevt");
  const atISO = normalizeTsISO(x.atISO || x.timestamp || x.at || nowISO());
  const type = String(x.type || x.kind || "event").toLowerCase();
  const message = String(x.message || x.title || x.note || "Meal event");
  const refs = safeObj(x.refs || x.references || {});
  return {
    id,
    atISO,
    dateISO: normalizeDateISO(x.dateISO || atISO),
    type,
    message,
    level: String(x.level || "info"),
    refs: {
      entryId: refs.entryId || x.entryId || null,
      sessionId: refs.sessionId || x.sessionId || null,
      recipeId: refs.recipeId || x.recipeId || null,
      planId: refs.planId || x.planId || null,
      receiptId: refs.receiptId || x.receiptId || null,
    },
    payload: x.payload != null ? x.payload : null,
    meta: safeObj(x.meta),
    createdAt: normalizeTsISO(x.createdAt || nowISO()),
  };
}

/* -----------------------------------------------------------------------------
 * Core persistence
 * -------------------------------------------------------------------------- */

async function dexieListAll(table) {
  if (!table) return null;
  try {
    if (typeof table.toArray === "function") return await table.toArray();
    // Dexie Table supports each() but toArray is most common
    return null;
  } catch {
    return null;
  }
}

async function dexiePut(table, row) {
  if (!table) return false;
  try {
    if (typeof table.put === "function") {
      await table.put(row);
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

async function dexieDelete(table, id) {
  if (!table) return false;
  try {
    if (typeof table.delete === "function") {
      await table.delete(id);
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

async function dexieGet(table, id) {
  if (!table) return null;
  try {
    if (typeof table.get === "function") return await table.get(id);
  } catch {
    return null;
  }
  return null;
}

/* -----------------------------------------------------------------------------
 * Store internals
 * -------------------------------------------------------------------------- */

// in-memory caches for quick reads; hydrated from persistence
let entriesCache = []; // array of entries
let eventsCache = []; // array of events

function updateCounts() {
  state.counts.entries = entriesCache.length;
  state.counts.events = eventsCache.length;
  state.lastUpdated = Date.now();
}

function markHydrated() {
  state.hydrated = true;
  state.error = null;
  state.dirty = false;
  updateCounts();
}

function markDirty() {
  state.dirty = true;
  state.lastUpdated = Date.now();
}

/* -----------------------------------------------------------------------------
 * Public API
 * -------------------------------------------------------------------------- */

export function getState() {
  return {
    ...state,
    counts: { ...state.counts },
  };
}

export function subscribe(fn) {
  if (typeof fn !== "function") return () => {};
  subs.add(fn);
  return () => subs.delete(fn);
}

export async function hydrate() {
  try {
    const eTable = entriesTable();
    const vTable = eventsTable();

    const dexieEntries = await dexieListAll(eTable);
    const dexieEvents = await dexieListAll(vTable);

    if (dexieEntries && dexieEvents) {
      entriesCache = dexieEntries.map(normalizeEntry);
      eventsCache = dexieEvents.map(normalizeEvent);
      markHydrated();
      emit("mealHistory.hydrated", {
        source: "dexie",
        counts: getState().counts,
      });
      notify();
      return { ok: true, source: "dexie", counts: getState().counts };
    }

    // Fallback localStorage
    const lsEntries = loadLS(LS_KEYS.entries, []);
    const lsEvents = loadLS(LS_KEYS.events, []);
    entriesCache = safeArr(lsEntries).map(normalizeEntry);
    eventsCache = safeArr(lsEvents).map(normalizeEvent);
    markHydrated();
    emit("mealHistory.hydrated", {
      source: "localStorage",
      counts: getState().counts,
    });
    notify();
    return { ok: true, source: "localStorage", counts: getState().counts };
  } catch (err) {
    state.error = String(err?.message || err);
    try {
      logger?.error?.("MealHistoryStore hydrate failed", err, {
        source: SOURCE,
      });
    } catch {
      // ignore
    }
    notify();
    return { ok: false, error: state.error };
  }
}

export async function persistNow() {
  // write-through caches to persistence
  try {
    const eTable = entriesTable();
    const vTable = eventsTable();

    // Prefer Dexie if tables exist
    if (eTable && vTable) {
      // naive: upsert all (safe + simple). For huge stores, you'd diff.
      for (const e of entriesCache) await dexiePut(eTable, e);
      for (const ev of eventsCache) await dexiePut(vTable, ev);

      state.dirty = false;
      state.lastUpdated = Date.now();
      saveLS(LS_KEYS.meta, { updatedAt: Date.now(), source: "dexie" });

      emit("mealHistory.persisted", {
        ok: true,
        source: "dexie",
        counts: getState().counts,
      });
      notify();
      return { ok: true, source: "dexie" };
    }

    // LocalStorage fallback
    const ok1 = saveLS(LS_KEYS.entries, entriesCache);
    const ok2 = saveLS(LS_KEYS.events, eventsCache);
    saveLS(LS_KEYS.meta, { updatedAt: Date.now(), source: "localStorage" });

    state.dirty = !(ok1 && ok2);
    state.lastUpdated = Date.now();

    emit("mealHistory.persisted", {
      ok: ok1 && ok2,
      source: "localStorage",
      counts: getState().counts,
    });
    notify();

    return { ok: ok1 && ok2, source: "localStorage" };
  } catch (err) {
    logWarn("MealHistoryStore persist failed", {
      err: String(err?.message || err),
    });
    return { ok: false, error: String(err?.message || err) };
  }
}

export async function clearAll() {
  entriesCache = [];
  eventsCache = [];
  updateCounts();
  markDirty();

  // Best-effort clear persistence
  try {
    const eTable = entriesTable();
    const vTable = eventsTable();
    if (eTable && typeof eTable.clear === "function") await eTable.clear();
    if (vTable && typeof vTable.clear === "function") await vTable.clear();
  } catch {
    // ignore
  }
  try {
    localStorage.removeItem(LS_KEYS.entries);
    localStorage.removeItem(LS_KEYS.events);
    localStorage.removeItem(LS_KEYS.meta);
  } catch {
    // ignore
  }

  emit("mealHistory.cleared", {});
  notify();
  return { ok: true };
}

/* -----------------------------------------------------------------------------
 * CRUD: Entries
 * -------------------------------------------------------------------------- */

export async function addEntry(entry) {
  const e = normalizeEntry(entry);

  // Upsert in cache
  const idx = entriesCache.findIndex((x) => x.id === e.id);
  if (idx >= 0)
    entriesCache[idx] = { ...entriesCache[idx], ...e, updatedAt: nowISO() };
  else entriesCache.push(e);

  // Write-through to Dexie if possible
  const t = entriesTable();
  if (t) {
    const ok = await dexiePut(t, e);
    if (!ok) logWarn("Failed to write meal entry to Dexie", { id: e.id });
  }

  markDirty();
  updateCounts();
  emit("mealHistory.entry.added", { entry: e });
  notify();
  schedulePersist(250);

  return e;
}

export async function updateEntry(id, patch) {
  const pid = String(id || "").trim();
  if (!pid) return null;

  const idx = entriesCache.findIndex((x) => x.id === pid);
  if (idx < 0) {
    // try to pull from Dexie
    const t = entriesTable();
    const row = await dexieGet(t, pid);
    if (row) {
      const e = normalizeEntry(row);
      entriesCache.push(e);
      updateCounts();
    } else {
      return null;
    }
  }

  const current = entriesCache.find((x) => x.id === pid);
  const merged = normalizeEntry({
    ...current,
    ...safeObj(patch),
    id: pid,
    updatedAt: nowISO(),
  });

  // Update cache
  entriesCache = entriesCache.map((x) => (x.id === pid ? merged : x));

  // Write-through
  const t = entriesTable();
  if (t) {
    const ok = await dexiePut(t, merged);
    if (!ok) logWarn("Failed to update meal entry in Dexie", { id: pid });
  }

  markDirty();
  updateCounts();
  emit("mealHistory.entry.updated", {
    id: pid,
    patch: safeObj(patch),
    entry: merged,
  });
  notify();
  schedulePersist(250);

  return merged;
}

export async function deleteEntry(id) {
  const pid = String(id || "").trim();
  if (!pid) return { ok: false, reason: "missing_id" };

  const before = entriesCache.length;
  entriesCache = entriesCache.filter((x) => x.id !== pid);

  const t = entriesTable();
  if (t) await dexieDelete(t, pid);

  markDirty();
  updateCounts();
  emit("mealHistory.entry.deleted", { id: pid });
  notify();
  schedulePersist(250);

  return { ok: true, removed: before - entriesCache.length };
}

/* -----------------------------------------------------------------------------
 * CRUD: Events
 * -------------------------------------------------------------------------- */

export async function addEvent(event) {
  const ev = normalizeEvent(event);

  const idx = eventsCache.findIndex((x) => x.id === ev.id);
  if (idx >= 0) eventsCache[idx] = ev;
  else eventsCache.push(ev);

  const t = eventsTable();
  if (t) {
    const ok = await dexiePut(t, ev);
    if (!ok) logWarn("Failed to write meal event to Dexie", { id: ev.id });
  }

  markDirty();
  updateCounts();
  emit("mealHistory.event.added", { event: ev });
  notify();
  schedulePersist(350);

  return ev;
}

/* -----------------------------------------------------------------------------
 * Queries
 * -------------------------------------------------------------------------- */

/**
 * List entries with simple filtering.
 * @param {object} [query]
 * @param {string} [query.startISO] - inclusive date ISO (YYYY-MM-DD)
 * @param {string} [query.endISO] - inclusive date ISO (YYYY-MM-DD)
 * @param {string} [query.mealType] - breakfast|lunch|dinner|snack|meal
 * @param {string} [query.search] - text search in title/notes
 * @param {number} [query.limit=200]
 * @param {string} [query.sort="desc"] - by atISO
 */
export function listEntries(query = {}) {
  const q = safeObj(query);
  const startISO = q.startISO ? normalizeDateISO(q.startISO) : null;
  const endISO = q.endISO ? normalizeDateISO(q.endISO) : null;
  const mealType = q.mealType ? String(q.mealType).toLowerCase() : null;
  const search = q.search ? String(q.search).toLowerCase() : null;
  const limit = clamp(q.limit ?? 200, 1, 2000);
  const sort =
    String(q.sort || "desc").toLowerCase() === "asc" ? "asc" : "desc";

  let out = entriesCache.slice();

  if (startISO) out = out.filter((e) => e.dateISO >= startISO);
  if (endISO) out = out.filter((e) => e.dateISO <= endISO);
  if (mealType) out = out.filter((e) => e.mealType === mealType);

  if (search) {
    out = out.filter((e) => {
      const t = String(e.title || "").toLowerCase();
      const n = String(e.notes || "").toLowerCase();
      const l = String(e.leftovers || "").toLowerCase();
      return t.includes(search) || n.includes(search) || l.includes(search);
    });
  }

  out.sort((a, b) => {
    const ta = new Date(a.atISO).getTime() || 0;
    const tb = new Date(b.atISO).getTime() || 0;
    return sort === "asc" ? ta - tb : tb - ta;
  });

  return out.slice(0, limit);
}

/**
 * List events with simple filtering.
 * @param {object} [query]
 * @param {string} [query.startISO]
 * @param {string} [query.endISO]
 * @param {string} [query.type]
 * @param {number} [query.limit=200]
 */
export function listEvents(query = {}) {
  const q = safeObj(query);
  const startISO = q.startISO ? normalizeDateISO(q.startISO) : null;
  const endISO = q.endISO ? normalizeDateISO(q.endISO) : null;
  const type = q.type ? String(q.type).toLowerCase() : null;
  const limit = clamp(q.limit ?? 200, 1, 2000);

  let out = eventsCache.slice();

  if (startISO) out = out.filter((e) => e.dateISO >= startISO);
  if (endISO) out = out.filter((e) => e.dateISO <= endISO);
  if (type) out = out.filter((e) => e.type === type);

  out.sort(
    (a, b) =>
      (new Date(b.atISO).getTime() || 0) - (new Date(a.atISO).getTime() || 0)
  );
  return out.slice(0, limit);
}

/**
 * Summarize entries for a date range.
 * @param {object} [range]
 * @param {string} [range.startISO]
 * @param {string} [range.endISO]
 */
export function summarize(range = {}) {
  const r = safeObj(range);
  const startISO = r.startISO ? normalizeDateISO(r.startISO) : null;
  const endISO = r.endISO ? normalizeDateISO(r.endISO) : null;

  const entries = listEntries({ startISO, endISO, sort: "asc", limit: 2000 });

  const byType = { breakfast: 0, lunch: 0, dinner: 0, snack: 0, meal: 0 };
  let totalServings = 0;
  let totalCost = 0;
  let costCount = 0;

  // optional nutrition rollups
  const nutrition = { calories: 0, protein: 0, carbs: 0, fat: 0 };
  let nutritionCount = 0;

  for (const e of entries) {
    const t = e.mealType || "meal";
    if (byType[t] != null) byType[t] += 1;
    else byType.meal += 1;

    if (Number.isFinite(e.servings)) totalServings += Number(e.servings);

    if (Number.isFinite(e.cost)) {
      totalCost += Number(e.cost);
      costCount += 1;
    }

    const n = safeObj(e.nutrition);
    const cal = Number(n.calories ?? n.kcal);
    const pro = Number(n.protein ?? n.pro);
    const car = Number(n.carbs ?? n.carbohydrates);
    const fat = Number(n.fat);

    if ([cal, pro, car, fat].some((v) => Number.isFinite(v))) {
      nutrition.calories += Number.isFinite(cal) ? cal : 0;
      nutrition.protein += Number.isFinite(pro) ? pro : 0;
      nutrition.carbs += Number.isFinite(car) ? car : 0;
      nutrition.fat += Number.isFinite(fat) ? fat : 0;
      nutritionCount += 1;
    }
  }

  const days = new Set(entries.map((e) => e.dateISO)).size;

  return {
    range: {
      startISO: startISO || entries[0]?.dateISO || null,
      endISO: endISO || entries[entries.length - 1]?.dateISO || null,
    },
    counts: {
      entries: entries.length,
      days,
      byType,
    },
    servings: {
      total: totalServings,
      avgPerEntry: entries.length ? totalServings / entries.length : 0,
    },
    cost: {
      total: totalCost,
      avgPerEntry: costCount ? totalCost / costCount : 0,
      entriesWithCost: costCount,
    },
    nutrition: {
      totals: nutrition,
      entriesWithNutrition: nutritionCount,
    },
  };
}

/* -----------------------------------------------------------------------------
 * Integration helpers (optional)
 * -------------------------------------------------------------------------- */

/**
 * Record a completed cooking session into meal history.
 * This is schema-tolerant; pass whatever session object you have.
 */
export async function recordFromCookingSession(session, options = {}) {
  const s = safeObj(session);
  const opts = safeObj(options);

  const dateISO = normalizeDateISO(
    opts.dateISO ||
      s.dateISO ||
      s.day ||
      s.startedAt ||
      s.startTime ||
      todayISO()
  );
  const atISO = normalizeTsISO(
    opts.atISO ||
      s.endedAt ||
      s.endTime ||
      s.completedAt ||
      s.startedAt ||
      nowISO()
  );

  const recipes = safeArr(s.recipes || s.meta?.recipes || s.data?.recipes);
  const title =
    opts.title ||
    s.title ||
    (recipes[0]?.title ? `Cooked: ${recipes[0]?.title}` : "Cooked session");

  const entry = await addEntry({
    id: opts.entryId || null,
    dateISO,
    atISO,
    mealType: opts.mealType || "dinner",
    title,
    servings: opts.servings ?? s.servings ?? s.portions ?? null,
    recipes,
    items: safeArr(s.items || s.meta?.items),
    nutrition: safeObj(opts.nutrition || s.nutrition || s.meta?.nutrition),
    notes: opts.notes || "",
    leftovers: opts.leftovers || "",
    tags: safeArr(opts.tags || s.tags),
    sources: { sessionId: s.id || s.sessionId || null },
    meta: { recordedFrom: "cookingSession", ...safeObj(opts.meta) },
  });

  await addEvent({
    type: "cooking_session_recorded",
    message: `Meal recorded from cooking session: ${entry.title}`,
    atISO,
    refs: { entryId: entry.id, sessionId: entry.sources?.sessionId || null },
  });

  return entry;
}

/* -----------------------------------------------------------------------------
 * Default export facade
 * -------------------------------------------------------------------------- */

const MealHistoryStore = {
  // store basics
  getState,
  subscribe,
  hydrate,
  persistNow,
  clearAll,

  // entries
  addEntry,
  updateEntry,
  deleteEntry,
  listEntries,

  // events
  addEvent,
  listEvents,

  // summaries
  summarize,

  // integration helpers
  recordFromCookingSession,
};

export default MealHistoryStore;
