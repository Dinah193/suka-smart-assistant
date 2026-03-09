// File: C:\Users\larho\suka-smart-assistant\src\store\BatchDraftStore.js
/**
 * BatchDraftStore (SSA)
 * -----------------------------------------------------------------------------
 * Purpose
 *  - Persist and manage "batch drafts": in-progress batch cooking session plans.
 *  - These drafts are not yet a running session (SessionRunner), but a staged
 *    plan that can be:
 *      • reviewed/edited
 *      • enriched with inventory links / prep tasks
 *      • converted into a cooking session blueprint
 *      • resumed after reloads/offline
 *
 * Design goals
 *  - Browser-safe, Vite-friendly (no Node imports).
 *  - Works with or without Dexie:
 *      • If Dexie "batch_drafts" exists -> persists there.
 *      • Else localStorage fallback (ssa.batchDrafts.v1).
 *      • Else in-memory.
 *  - Event-bus friendly:
 *      • batchDrafts.hydrated
 *      • batchDrafts.changed
 *      • batchDrafts.active.changed
 *
 * Draft shape (tolerant)
 *  {
 *    id: string,
 *    householdId?: string,
 *    userId?: string,
 *
 *    title: string,                        // "Sunday Batch", "Feast Prep", etc.
 *    status: "draft"|"ready"|"archived",
 *
 *    // meal/recipe selection
 *    recipeIds?: string[],                 // RecipeLibrary ids
 *    recipes?: any[],                      // optional embedded recipe snapshots
 *    servings?: number,
 *
 *    // planning
 *    plannedForISO?: string,               // target date/time
 *    durationMinutes?: number,
 *    notes?: string,
 *    tags?: string[],
 *
 *    // derived/enrichment
 *    ingredientNeeds?: any[],              // normalized ingredient list
 *    inventoryLinks?: any[],               // mapping ingredients -> inventory ids
 *    prepTasks?: any[],                    // parsed prep checklist/tasks
 *    timers?: any[],                       // session timers derived from steps
 *
 *    // "web of meaning" hooks
 *    constraints?: {
 *      sabbathAware?: boolean,
 *      quietHours?: any,
 *      dietMode?: string,                  // keto/carnivore/etc.
 *      allergens?: string[],
 *      avoidIngredients?: string[]
 *    },
 *
 *    // export path
 *    blueprint?: any,                      // L3 session blueprint
 *    lastBlueprintAtISO?: string,
 *
 *    // audit
 *    createdAtISO: string,
 *    updatedAtISO: string,
 *    meta?: object
 *  }
 */

const SOURCE = "store.BatchDraftStore";
const STORAGE_KEY = "ssa.batchDrafts.v1";

/* -----------------------------------------------------------------------------
 * Optional deps (safe dynamic imports)
 * -------------------------------------------------------------------------- */

let _depsPromise = null;
async function getDeps() {
  if (_depsPromise) return _depsPromise;

  _depsPromise = (async () => {
    let bus = null;
    let db = null;

    try {
      const mod = await import("../services/automation/eventBus.js").catch(
        () => null
      );
      bus =
        mod?.eventBus ||
        mod?.bus ||
        mod?.default?.eventBus ||
        mod?.default ||
        null;
    } catch {
      bus = null;
    }

    try {
      const mod = await import("../services/db.js").catch(() => null);
      db = mod?.db || mod?.default || mod || null;
    } catch {
      db = null;
    }

    return { bus, db };
  })();

  return _depsPromise;
}

function emit(bus, event, payload) {
  try {
    if (!bus) return;
    if (typeof bus.emit === "function") bus.emit(event, payload);
    else if (typeof bus.publish === "function") bus.publish(event, payload);
  } catch {
    /* no-op */
  }
}

/* -----------------------------------------------------------------------------
 * Utilities
 * -------------------------------------------------------------------------- */

const isObj = (x) => x && typeof x === "object" && !Array.isArray(x);
const safeObj = (x) => (isObj(x) ? x : {});
const safeArr = (x) => (Array.isArray(x) ? x : []);
const nowISO = () => new Date().toISOString();

const keyOf = (s) =>
  String(s || "")
    .trim()
    .toLowerCase()
    .replace(/[^\w]+/g, "_")
    .replace(/^_+|_+$/g, "");

function stableId(prefix = "bd") {
  return `${prefix}_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

function deepMerge(base, patch) {
  if (!isObj(base) || !isObj(patch)) return patch;
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (isObj(v) && isObj(out[k])) out[k] = deepMerge(out[k], v);
    else out[k] = v;
  }
  return out;
}

function normalizeDraft(draft, { keepId = true } = {}) {
  const x = safeObj(draft);
  const id = keepId ? String(x.id || "") : "";
  const finalId = id || String(x.id || stableId("bd"));

  const createdAtISO = x.createdAtISO
    ? String(x.createdAtISO)
    : x.createdAt
    ? String(x.createdAt)
    : nowISO();
  const updatedAtISO = nowISO();

  const status = x.status ? String(x.status) : "draft";
  const title = x.title ? String(x.title) : "Batch Draft";

  return {
    ...safeObj(x),
    id: finalId,
    householdId: x.householdId ? String(x.householdId) : undefined,
    userId: x.userId ? String(x.userId) : undefined,

    title,
    status,

    recipeIds: safeArr(x.recipeIds).map(String).filter(Boolean),
    recipes: safeArr(x.recipes),
    servings: Number.isFinite(+x.servings) ? +x.servings : x.servings,

    plannedForISO: x.plannedForISO ? String(x.plannedForISO) : "",
    durationMinutes: Number.isFinite(+x.durationMinutes)
      ? +x.durationMinutes
      : x.durationMinutes,

    notes: x.notes ? String(x.notes) : "",
    tags: safeArr(x.tags).map(String),

    ingredientNeeds: safeArr(x.ingredientNeeds),
    inventoryLinks: safeArr(x.inventoryLinks),
    prepTasks: safeArr(x.prepTasks),
    timers: safeArr(x.timers),

    constraints: safeObj(x.constraints),

    blueprint: x.blueprint ?? null,
    lastBlueprintAtISO: x.lastBlueprintAtISO
      ? String(x.lastBlueprintAtISO)
      : "",

    createdAtISO,
    updatedAtISO,
    meta: safeObj(x.meta),
    source: x.source || SOURCE,
  };
}

function sortDrafts(list) {
  const arr = safeArr(list).slice();
  arr.sort((a, b) => {
    // ready first, then recent updated
    const rank = (s) => (s === "ready" ? 2 : s === "draft" ? 1 : 0);
    const ra = rank(String(a?.status || ""));
    const rb = rank(String(b?.status || ""));
    if (rb !== ra) return rb - ra;

    const ua = String(a?.updatedAtISO || a?.updatedAt || "");
    const ub = String(b?.updatedAtISO || b?.updatedAt || "");
    if (ub !== ua) return ub.localeCompare(ua);

    return String(a?.title || "").localeCompare(String(b?.title || ""));
  });
  return arr;
}

function loadLS() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { drafts: [], activeDraftId: null };
    const parsed = JSON.parse(raw);
    return {
      drafts: safeArr(parsed.drafts),
      activeDraftId: parsed.activeDraftId ? String(parsed.activeDraftId) : null,
    };
  } catch {
    return { drafts: [], activeDraftId: null };
  }
}

function saveLS(state) {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        v: 1,
        savedAtISO: nowISO(),
        drafts: safeArr(state.drafts),
        activeDraftId: state.activeDraftId ? String(state.activeDraftId) : null,
      })
    );
    return true;
  } catch {
    return false;
  }
}

/* -----------------------------------------------------------------------------
 * Internal state + subscribers
 * -------------------------------------------------------------------------- */

const _state = {
  hydrated: false,
  loading: false,
  error: null,

  drafts: [],
  activeDraftId: null,

  source: "memory", // "dexie" | "localStorage" | "memory"
  lastLoadedAtISO: null,
  lastSavedAtISO: null,
};

const _subs = new Set();
function _notify() {
  for (const fn of _subs) {
    try {
      fn();
    } catch {}
  }
}
function _set(partial) {
  Object.assign(_state, partial);
  _notify();
}

function getSnapshot() {
  return {
    hydrated: _state.hydrated,
    loading: _state.loading,
    error: _state.error,
    drafts: sortDrafts(_state.drafts),
    activeDraftId: _state.activeDraftId,
    source: _state.source,
    lastLoadedAtISO: _state.lastLoadedAtISO,
    lastSavedAtISO: _state.lastSavedAtISO,
  };
}

function subscribe(fn) {
  _subs.add(fn);
  return () => _subs.delete(fn);
}

/* -----------------------------------------------------------------------------
 * Dexie helpers
 * -------------------------------------------------------------------------- */

async function getDraftsTable(db) {
  try {
    if (!db) return null;
    if (db.batch_drafts) return db.batch_drafts;
    if (db.batchDrafts) return db.batchDrafts;
    if (typeof db.table === "function") {
      // prefer snake case first
      try {
        return db.table("batch_drafts");
      } catch {
        return db.table("batchDrafts");
      }
    }
    return null;
  } catch {
    return null;
  }
}

/* -----------------------------------------------------------------------------
 * Hydrate / persist
 * -------------------------------------------------------------------------- */

async function hydrate() {
  if (_state.hydrated || _state.loading) return getSnapshot();
  _set({ loading: true, error: null });

  const { bus, db } = await getDeps();

  // Dexie first
  try {
    const t = await getDraftsTable(db);
    if (t && typeof t.toArray === "function") {
      const all = await t.toArray();
      const drafts = safeArr(all).map((d) =>
        normalizeDraft(d, { keepId: true })
      );

      // infer active draft if one has status ready and is most recent
      let activeDraftId = _state.activeDraftId;
      if (!activeDraftId) {
        const ready = sortDrafts(drafts).find((d) => d.status === "ready");
        if (ready) activeDraftId = ready.id;
      }

      _set({
        drafts,
        activeDraftId: activeDraftId || null,
        hydrated: true,
        loading: false,
        source: "dexie",
        lastLoadedAtISO: nowISO(),
      });

      emit(bus, "batchDrafts.hydrated", {
        at: _state.lastLoadedAtISO,
        source: "dexie",
        count: drafts.length,
      });
      return getSnapshot();
    }
  } catch (e) {
    _set({ error: e?.message || String(e) });
  }

  // localStorage fallback
  try {
    const ls = loadLS();
    const drafts = safeArr(ls.drafts).map((d) =>
      normalizeDraft(d, { keepId: true })
    );
    _set({
      drafts,
      activeDraftId: ls.activeDraftId || null,
      hydrated: true,
      loading: false,
      source: "localStorage",
      lastLoadedAtISO: nowISO(),
    });

    emit(bus, "batchDrafts.hydrated", {
      at: _state.lastLoadedAtISO,
      source: "localStorage",
      count: drafts.length,
    });
    return getSnapshot();
  } catch (e) {
    _set({
      hydrated: true,
      loading: false,
      source: "memory",
      lastLoadedAtISO: nowISO(),
      error: e?.message || String(e),
    });
    emit(bus, "batchDrafts.hydrated", {
      at: _state.lastLoadedAtISO,
      source: "memory",
      count: _state.drafts.length,
    });
    return getSnapshot();
  }
}

async function persistNow() {
  const { bus, db } = await getDeps();
  const drafts = safeArr(_state.drafts);

  // Dexie
  try {
    const t = await getDraftsTable(db);
    if (t && typeof t.bulkPut === "function") {
      await t.bulkPut(drafts);
      _set({ lastSavedAtISO: nowISO(), source: "dexie" });
      emit(bus, "batchDrafts.persisted", {
        at: _state.lastSavedAtISO,
        source: "dexie",
        count: drafts.length,
      });
      return { ok: true, source: "dexie" };
    }
  } catch (e) {
    _set({ error: e?.message || String(e) });
  }

  // localStorage
  const ok = saveLS({ drafts, activeDraftId: _state.activeDraftId });
  _set({
    lastSavedAtISO: nowISO(),
    source: ok ? "localStorage" : _state.source,
  });
  emit(bus, "batchDrafts.persisted", {
    at: _state.lastSavedAtISO,
    source: ok ? "localStorage" : _state.source,
    count: drafts.length,
  });
  return { ok, source: ok ? "localStorage" : _state.source };
}

/* -----------------------------------------------------------------------------
 * CRUD
 * -------------------------------------------------------------------------- */

function getAll() {
  return sortDrafts(_state.drafts);
}

function getById(id) {
  const did = String(id || "");
  if (!did) return null;
  return _state.drafts.find((d) => String(d.id) === did) || null;
}

function getActiveDraft() {
  if (_state.activeDraftId) return getById(_state.activeDraftId);
  return sortDrafts(_state.drafts)[0] || null;
}

function setActiveDraft(id) {
  const did = String(id || "");
  if (did && !getById(did)) return null;

  _set({ activeDraftId: did || null });

  getDeps().then(({ bus }) => {
    emit(bus, "batchDrafts.active.changed", {
      activeDraftId: _state.activeDraftId,
      at: nowISO(),
    });
  });

  persistNow().catch(() => {});
  return getActiveDraft();
}

function upsert(draftOrPartial) {
  const incoming = normalizeDraft(draftOrPartial, { keepId: true });
  const existing = getById(incoming.id);

  const next = existing
    ? (() => {
        const merged = deepMerge(existing, incoming);
        merged.createdAtISO = existing.createdAtISO || incoming.createdAtISO;
        merged.updatedAtISO = nowISO();
        return merged;
      })()
    : incoming;

  const drafts = _state.drafts.filter((d) => d.id !== next.id);
  drafts.push(next);

  let activeDraftId = _state.activeDraftId;
  if (!activeDraftId) activeDraftId = next.id;

  _set({ drafts, activeDraftId });

  getDeps().then(({ bus }) => {
    emit(bus, "batchDrafts.changed", {
      type: existing ? "upsert" : "create",
      draftId: next.id,
      at: nowISO(),
    });
  });

  persistNow().catch(() => {});
  return next;
}

function createDraft({
  title = "New Batch Draft",
  householdId,
  userId,
  recipeIds = [],
  recipes = [],
  servings,
  plannedForISO = "",
  durationMinutes,
  notes = "",
  tags = [],
  constraints = {},
  meta = {},
} = {}) {
  const d = normalizeDraft(
    {
      id: stableId("bd"),
      title,
      status: "draft",
      householdId,
      userId,
      recipeIds,
      recipes,
      servings,
      plannedForISO,
      durationMinutes,
      notes,
      tags,
      constraints,
      meta,
    },
    { keepId: true }
  );
  const created = upsert(d);
  setActiveDraft(created.id);
  return created;
}

function removeDraft(id) {
  const did = String(id || "");
  if (!did) return false;

  const before = _state.drafts.length;
  const drafts = _state.drafts.filter((d) => d.id !== did);

  let activeDraftId = _state.activeDraftId;
  if (activeDraftId === did) {
    activeDraftId = sortDrafts(drafts)[0]?.id || null;
  }

  _set({ drafts, activeDraftId });

  const changed = before !== drafts.length;
  if (changed) {
    getDeps().then(({ bus }) => {
      emit(bus, "batchDrafts.changed", {
        type: "remove",
        draftId: did,
        at: nowISO(),
      });
      emit(bus, "batchDrafts.active.changed", { activeDraftId, at: nowISO() });
    });
    persistNow().catch(() => {});
  }
  return changed;
}

function archiveDraft(id) {
  const d = getById(id);
  if (!d) return null;
  return upsert({ ...d, status: "archived" });
}

function markReady(id, ready = true) {
  const d = getById(id);
  if (!d) return null;
  return upsert({ ...d, status: ready ? "ready" : "draft" });
}

/* -----------------------------------------------------------------------------
 * Enrichment helpers
 * -------------------------------------------------------------------------- */

/**
 * Set/merge ingredient needs list (normalized list of items required)
 * - Accepts array (replace) or function(prev)->next
 */
function setIngredientNeeds(draftId, nextOrUpdater) {
  const d = getById(draftId);
  if (!d) return null;

  const next =
    typeof nextOrUpdater === "function"
      ? nextOrUpdater(safeArr(d.ingredientNeeds))
      : nextOrUpdater;

  return upsert({ ...d, ingredientNeeds: safeArr(next) });
}

/**
 * Set/merge inventory links (mapping ingredients -> inventory ids/locations)
 */
function setInventoryLinks(draftId, nextOrUpdater) {
  const d = getById(draftId);
  if (!d) return null;

  const next =
    typeof nextOrUpdater === "function"
      ? nextOrUpdater(safeArr(d.inventoryLinks))
      : nextOrUpdater;

  return upsert({ ...d, inventoryLinks: safeArr(next) });
}

/**
 * Set/merge prep tasks array
 */
function setPrepTasks(draftId, nextOrUpdater) {
  const d = getById(draftId);
  if (!d) return null;

  const next =
    typeof nextOrUpdater === "function"
      ? nextOrUpdater(safeArr(d.prepTasks))
      : nextOrUpdater;

  return upsert({ ...d, prepTasks: safeArr(next) });
}

/**
 * Set/merge timers array
 */
function setTimers(draftId, nextOrUpdater) {
  const d = getById(draftId);
  if (!d) return null;

  const next =
    typeof nextOrUpdater === "function"
      ? nextOrUpdater(safeArr(d.timers))
      : nextOrUpdater;

  return upsert({ ...d, timers: safeArr(next) });
}

/**
 * Attach/update blueprint (L3) for draft
 */
function setBlueprint(draftId, blueprint) {
  const d = getById(draftId);
  if (!d) return null;

  return upsert({
    ...d,
    blueprint: blueprint ?? null,
    lastBlueprintAtISO: blueprint ? nowISO() : d.lastBlueprintAtISO,
    status: blueprint
      ? d.status === "archived"
        ? "archived"
        : "ready"
      : d.status,
  });
}

/* -----------------------------------------------------------------------------
 * Query helpers
 * -------------------------------------------------------------------------- */

function findByTag(tag) {
  const q = keyOf(tag);
  if (!q) return [];
  return sortDrafts(
    _state.drafts.filter((d) => safeArr(d.tags).map(keyOf).includes(q))
  );
}

function listReadyDrafts() {
  return sortDrafts(_state.drafts.filter((d) => String(d.status) === "ready"));
}

function listDraftsForHousehold(householdId) {
  const hid = String(householdId || "");
  if (!hid) return sortDrafts(_state.drafts);
  return sortDrafts(
    _state.drafts.filter((d) => String(d.householdId || "") === hid)
  );
}

/* -----------------------------------------------------------------------------
 * Optional: Convert draft -> session blueprint via ImportRouter (if present)
 * -------------------------------------------------------------------------- */

/**
 * buildBlueprint(draftId, options)
 * - Best-effort: if ImportRouter exists and supports routeImport, we pass a
 *   structured object with kindHint "cook_plan" and attach the draft.
 */
async function buildBlueprint(draftId, options = {}) {
  const d = getById(draftId);
  if (!d) return { ok: false, error: "draft_not_found" };

  let ImportRouter = null;
  try {
    const mod = await import("../services/imports/ImportRouter.js").catch(
      () => null
    );
    ImportRouter = mod?.default || mod || null;
  } catch {
    ImportRouter = null;
  }

  if (!ImportRouter?.routeImport) {
    // no router; store a minimal blueprint shell
    const minimal = {
      id: stableId("bp"),
      domain: "cooking",
      kind: "batch",
      title: d.title,
      createdFrom: { draftId: d.id },
      steps: [],
      meta: {
        note: "ImportRouter unavailable; generated minimal blueprint shell.",
      },
    };
    setBlueprint(d.id, minimal);
    return { ok: true, blueprint: minimal, fallback: true };
  }

  const res = await ImportRouter.routeImport(
    {
      type: "cook_plan",
      draft: d,
      recipes: d.recipes,
      recipeIds: d.recipeIds,
      ingredientNeeds: d.ingredientNeeds,
      prepTasks: d.prepTasks,
      timers: d.timers,
      constraints: d.constraints,
    },
    {
      source: "batchDraft",
      kindHint: "cook_plan",
      mode: "parseAndBlueprint",
      cache: true,
      emit: true,
      meta: { draftId: d.id, ...safeObj(options.meta) },
      ...safeObj(options),
    }
  );

  if (res?.blueprint) setBlueprint(d.id, res.blueprint);
  return { ok: !!res?.ok, ...res };
}

/* -----------------------------------------------------------------------------
 * Public facade
 * -------------------------------------------------------------------------- */

const BatchDraftStore = {
  // status
  hydrate,
  persistNow,
  getSnapshot,
  subscribe,

  // drafts
  getAll,
  getById,
  getActiveDraft,
  setActiveDraft,
  createDraft,
  upsert,
  removeDraft,
  archiveDraft,
  markReady,

  // enrichment
  setIngredientNeeds,
  setInventoryLinks,
  setPrepTasks,
  setTimers,
  setBlueprint,

  // queries
  findByTag,
  listReadyDrafts,
  listDraftsForHousehold,

  // conversion
  buildBlueprint,

  // diagnostics
  _unsafeState: _state,
};

export default BatchDraftStore;
export { BatchDraftStore };

// ✅ Compatibility named export expected by mealPlanEngine.js
export const BatchDrafts = BatchDraftStore;
