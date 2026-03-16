// File: src/services/meals/MealPlanStore.js
/**
 * MealPlanStore
 * -----------------------------------------------------------------------------
 * Purpose
 *  - Browser-safe store for Meal Plans (planned meals, rotations, weekly plans).
 *  - Dexie-first persistence (db.meal_plans or db.mealPlans), with localStorage fallback.
 *  - Event-driven: emits lifecycle events via eventBus if available.
 *  - Works even if DB tables are not yet created (no hard crashes).
 *
 * Intended usage
 *  - UI pages: subscribe() and selectors to render plan lists / active plan.
 *  - Meal planning engines: create/update plans, attach day selections, lock meals.
 *  - Export/Import: serialize plans to JSON blobs for sharing or backup.
 *
 * Plan record shape (store-level)
 *  {
 *    id: string,
 *    title: string,
 *    description: string,
 *    status: "draft"|"active"|"archived",
 *    tags: string[],
 *    householdId: string,
 *    ownerId: string,
 *    timezone: string,
 *    weekStartISO: string,        // ISO datetime (or date-only) of week start
 *    days: {
 *      "YYYY-MM-DD": {
 *        breakfast?: MealPick,
 *        lunch?: MealPick,
 *        dinner?: MealPick,
 *        snacks?: MealPick[]|MealPick,
 *        notes?: string
 *      }
 *    },
 *    constraints: object,          // diet mode, allergies, cuisines, etc.
 *    rhythm: object,              // fixed protein anchors, soup/sandwich, etc.
 *    meta: {
 *      source?: string,
 *      version?: number,
 *      createdBy?: string,
 *      lastEditor?: string
 *    },
 *    createdAtISO: string,
 *    updatedAtISO: string,
 *    version: number
 *  }
 *
 * MealPick shape (flexible)
 *  { id, title, recipeId?, tags?, proteins?, timeMinutes?, soup?, sandwich?, leftoversFriendly?, recipe? }
 *
 * Public API
 *  - getState()
 *  - subscribe(fn)
 *  - hydrate({ householdId, ownerId }?)
 *  - list({ householdId?, status?, tag?, q?, limit?, offset? })
 *  - getById(id)
 *  - getActive({ householdId }?)
 *  - setActive(id, { householdId }?)
 *  - create(planPartial)
 *  - update(id, patchOrUpdater)
 *  - remove(id)
 *  - upsert(plan)
 *  - setDayPick(planId, dayKey, slot, pick)        // slot: breakfast|lunch|dinner|snacks
 *  - setDayNotes(planId, dayKey, notes)
 *  - exportPlan(id)
 *  - importPlan(blobOrObject, { activate? })
 *  - persistNow()
 *  - reset({ keepStorage? })
 *
 * Notes
 *  - This store intentionally does not depend on React. Use useSyncExternalStore in hooks.
 *  - Safe in Vite builds (no node imports).
 */

const SOURCE = "meals.MealPlanStore";

/* ---------------------------------- config --------------------------------- */
const CONFIG = {
  lsKey: "ssa.mealPlans",
  lsMetaKey: "ssa.mealPlans.meta",
  persistDebounceMs: 400,
  maxStoredPlans: 500,
  schemaVersion: 1,
  defaultTimezone: "America/Chicago", // user stated timezone; override per profile
};

/* -------------------------- optional dependency shims ----------------------- */
async function tryGetDB() {
  try {
    const mod = await import(/* @vite-ignore */ "@/services/db");
    return mod?.db || mod?.default || null;
  } catch {
    return null;
  }
}

async function tryGetEventBus() {
  try {
    const mod = await import(/* @vite-ignore */ "@/services/events/eventBus");
    return mod?.eventBus || mod?.default || null;
  } catch {
    return null;
  }
}

async function emit(evt, payload) {
  const bus = await tryGetEventBus();
  if (!bus) return;
  try {
    if (typeof bus.emit === "function") bus.emit(evt, payload);
    else if (typeof bus.publish === "function") bus.publish(evt, payload);
  } catch {
    // never crash
  }
}

/* ---------------------------------- utils ---------------------------------- */
function isObject(v) {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

function safeStr(v, fallback = "") {
  if (v == null) return fallback;
  return String(v);
}

function asArray(v) {
  return Array.isArray(v) ? v : v == null ? [] : [v];
}

function uniq(arr) {
  const out = [];
  const s = new Set();
  for (const x of arr) {
    const k = safeStr(x).trim();
    if (!k) continue;
    const kk = k.toLowerCase();
    if (s.has(kk)) continue;
    s.add(kk);
    out.push(k);
  }
  return out;
}

function nowISO() {
  return new Date().toISOString();
}

function toISODateOnly(isoOrDate) {
  const d = isoOrDate ? new Date(isoOrDate) : new Date();
  if (Number.isNaN(d.getTime())) return "";
  // date-only key in local time? We prefer UTC-stable for indexing:
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
    .toISOString()
    .slice(0, 10);
}

function makeId(prefix = "mealplan") {
  const rand = Math.random().toString(16).slice(2);
  const t = Date.now().toString(16);
  return `${prefix}_${t}_${rand}`;
}

function deepMerge(target, patch) {
  if (!isObject(target) || !isObject(patch)) return patch;
  const out = { ...target };
  for (const k of Object.keys(patch)) {
    const pv = patch[k];
    const tv = out[k];
    if (isObject(tv) && isObject(pv)) out[k] = deepMerge(tv, pv);
    else out[k] = pv;
  }
  return out;
}

function stableTrimLower(s) {
  return safeStr(s).trim().toLowerCase();
}

function normalizePlan(raw) {
  const id = safeStr(raw?.id || raw?._id || raw?.key || "");
  const title = safeStr(raw?.title || raw?.name || "Meal Plan");
  const description = safeStr(raw?.description || "");
  const status = safeStr(raw?.status || "draft").toLowerCase();
  const tags = uniq(asArray(raw?.tags).map((t) => safeStr(t)));

  const householdId = safeStr(raw?.householdId || "");
  const ownerId = safeStr(raw?.ownerId || "");
  const timezone = safeStr(raw?.timezone || CONFIG.defaultTimezone);

  const weekStartISO = safeStr(raw?.weekStartISO || raw?.weekStart || "");
  const days = isObject(raw?.days) ? raw.days : {};
  const constraints = isObject(raw?.constraints) ? raw.constraints : {};
  const rhythm = isObject(raw?.rhythm) ? raw.rhythm : {};

  const createdAtISO = safeStr(raw?.createdAtISO || raw?.createdAt || nowISO());
  const updatedAtISO = safeStr(raw?.updatedAtISO || raw?.updatedAt || nowISO());
  const version =
    typeof raw?.version === "number" ? raw.version : CONFIG.schemaVersion;

  const meta = isObject(raw?.meta) ? raw.meta : {};

  return {
    ...raw,
    id: id || makeId("mealplan"),
    title,
    description,
    status: status === "active" || status === "archived" ? status : "draft",
    tags,
    householdId,
    ownerId,
    timezone,
    weekStartISO,
    days,
    constraints,
    rhythm,
    meta: { version: CONFIG.schemaVersion, ...meta },
    createdAtISO,
    updatedAtISO,
    version,
  };
}

function safeClone(obj) {
  try {
    return JSON.parse(JSON.stringify(obj));
  } catch {
    // best effort clone
    if (!isObject(obj) && !Array.isArray(obj)) return obj;
    return Array.isArray(obj) ? obj.slice() : { ...obj };
  }
}

/* ------------------------------- persistence -------------------------------- */
function lsReadJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function lsWriteJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

async function getPlansTable(db) {
  if (!db) return null;
  // common candidate names; prefer meal_plans
  const names = [
    "meal_plans",
    "mealPlans",
    "plans_meals",
    "plansMeal",
    "plans",
  ];
  for (const n of names) {
    if (
      db[n] &&
      typeof db[n].put === "function" &&
      typeof db[n].toArray === "function"
    ) {
      return db[n];
    }
  }
  return null;
}

async function loadFromDexie() {
  const db = await tryGetDB();
  const table = await getPlansTable(db);
  if (!table) return null;

  const rows = await table.toArray();
  return rows.map(normalizePlan);
}

async function saveToDexie(plans) {
  const db = await tryGetDB();
  const table = await getPlansTable(db);
  if (!table) return false;

  // Put plans; Dexie bulkPut preferred but optional
  try {
    if (typeof table.bulkPut === "function") {
      await table.bulkPut(plans);
    } else {
      for (const p of plans) await table.put(p);
    }
    return true;
  } catch {
    return false;
  }
}

function loadFromLocalStorage() {
  const raw = lsReadJSON(CONFIG.lsKey, []);
  const list = Array.isArray(raw) ? raw : [];
  return list.map(normalizePlan);
}

function saveToLocalStorage(plans) {
  const capped = plans.slice(0, CONFIG.maxStoredPlans).map((p) => safeClone(p));
  const ok = lsWriteJSON(CONFIG.lsKey, capped);
  return ok;
}

function loadMetaFromLocalStorage() {
  const meta = lsReadJSON(CONFIG.lsMetaKey, null);
  return isObject(meta) ? meta : null;
}

function saveMetaToLocalStorage(meta) {
  return lsWriteJSON(CONFIG.lsMetaKey, meta);
}

/* ---------------------------------- state ---------------------------------- */
const state = {
  status: {
    hydrated: false,
    loading: false,
    error: null,
    dirty: false,
    persisted: false,
    source: "memory", // "dexie" | "localStorage" | "memory"
    lastLoadedAtISO: "",
    lastSavedAtISO: "",
  },

  context: {
    householdId: "",
    ownerId: "",
  },

  // normalized storage
  byId: new Map(), // id -> plan
  order: [], // ids sorted by updatedAt desc

  activeByHousehold: {}, // householdId -> planId

  // simple query cache
  lastList: {
    key: "",
    ids: [],
    atISO: "",
  },
};

const listeners = new Set();
let persistTimer = null;

/* --------------------------------- internal -------------------------------- */
function notify() {
  for (const fn of listeners) {
    try {
      fn();
    } catch {
      // ignore
    }
  }
}

function setStatus(patch) {
  state.status = { ...state.status, ...patch };
  notify();
}

function rebuildOrder() {
  const all = Array.from(state.byId.values());
  all.sort((a, b) => {
    const ta = Date.parse(a.updatedAtISO || a.createdAtISO || "") || 0;
    const tb = Date.parse(b.updatedAtISO || b.createdAtISO || "") || 0;
    return tb - ta;
  });
  state.order = all.map((p) => p.id);
}

function markDirty(reason = "") {
  setStatus({
    dirty: true,
    persisted: false,
    error: null,
  });
  emit("mealplanstore.dirty", { source: SOURCE, reason, atISO: nowISO() });
  schedulePersist();
}

function schedulePersist() {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    // fire and forget; store keeps state consistent
    persistNow().catch(() => {});
  }, CONFIG.persistDebounceMs);
}

function indexPlans(plans) {
  state.byId.clear();
  for (const p of plans) {
    const plan = normalizePlan(p);
    state.byId.set(plan.id, plan);
  }
  rebuildOrder();
}

function getAllPlansArray() {
  return state.order.map((id) => state.byId.get(id)).filter(Boolean);
}

function getHouseholdIdOrDefault(householdId) {
  const h = safeStr(householdId || state.context.householdId || "");
  return h || "default";
}

function ensureActiveForHousehold(householdId) {
  const h = getHouseholdIdOrDefault(householdId);
  const current = state.activeByHousehold[h];
  if (current && state.byId.has(current)) return current;

  // choose most recently updated plan for this household; else first overall
  const candidates = getAllPlansArray().filter(
    (p) => getHouseholdIdOrDefault(p.householdId) === h
  );
  const pick =
    candidates.find((p) => p.status === "active") || candidates[0] || null;
  if (pick) {
    state.activeByHousehold[h] = pick.id;
    saveMetaToLocalStorage({ activeByHousehold: state.activeByHousehold });
    return pick.id;
  }
  return "";
}

function matchesQuery(plan, { householdId, status, tag, q }) {
  if (!plan) return false;

  const h = householdId ? getHouseholdIdOrDefault(householdId) : "";
  if (h && getHouseholdIdOrDefault(plan.householdId) !== h) return false;

  const st = stableTrimLower(status);
  if (st && stableTrimLower(plan.status) !== st) return false;

  const tg = stableTrimLower(tag);
  if (tg) {
    const tags = asArray(plan.tags).map((t) => stableTrimLower(t));
    if (!tags.includes(tg)) return false;
  }

  const qq = stableTrimLower(q);
  if (qq) {
    const hay = `${plan.title} ${plan.description} ${(plan.tags || []).join(
      " "
    )}`.toLowerCase();
    if (!hay.includes(qq)) return false;
  }

  return true;
}

/* --------------------------------- API ------------------------------------- */
function getState() {
  // expose a read-only snapshot suitable for rendering
  return {
    status: { ...state.status },
    context: { ...state.context },
    order: state.order.slice(),
    activeByHousehold: { ...state.activeByHousehold },
    // NOTE: we do not clone all plans here (can be large); use selectors
  };
}

function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Hydrate store from Dexie (preferred) else localStorage.
 * Call this early (e.g., app bootstrap) or lazily from meal pages.
 */
async function hydrate({ householdId = "", ownerId = "" } = {}) {
  if (state.status.loading) return { ok: true, skipped: true };

  setStatus({ loading: true, error: null });

  // Save context
  state.context = {
    householdId: safeStr(householdId || state.context.householdId || ""),
    ownerId: safeStr(ownerId || state.context.ownerId || ""),
  };

  // Try Dexie first
  try {
    const dexiePlans = await loadFromDexie();
    if (dexiePlans) {
      indexPlans(dexiePlans);
      setStatus({
        hydrated: true,
        loading: false,
        source: "dexie",
        lastLoadedAtISO: nowISO(),
        error: null,
      });

      // Load meta (active plan selections) from localStorage (safe cross-storage)
      const meta = loadMetaFromLocalStorage();
      if (meta?.activeByHousehold && isObject(meta.activeByHousehold)) {
        state.activeByHousehold = { ...meta.activeByHousehold };
      }
      ensureActiveForHousehold(state.context.householdId);

      await emit("mealplanstore.hydrated", {
        source: SOURCE,
        storage: "dexie",
        count: state.byId.size,
        atISO: state.status.lastLoadedAtISO,
      });

      notify();
      return { ok: true, storage: "dexie", count: state.byId.size };
    }
  } catch (e) {
    // fall through to localStorage
    setStatus({ error: e?.message || String(e) });
  }

  // Fallback localStorage
  try {
    const lsPlans = loadFromLocalStorage();
    indexPlans(lsPlans);

    const meta = loadMetaFromLocalStorage();
    if (meta?.activeByHousehold && isObject(meta.activeByHousehold)) {
      state.activeByHousehold = { ...meta.activeByHousehold };
    }
    ensureActiveForHousehold(state.context.householdId);

    setStatus({
      hydrated: true,
      loading: false,
      source: "localStorage",
      lastLoadedAtISO: nowISO(),
      error: null,
    });

    await emit("mealplanstore.hydrated", {
      source: SOURCE,
      storage: "localStorage",
      count: state.byId.size,
      atISO: state.status.lastLoadedAtISO,
    });

    notify();
    return { ok: true, storage: "localStorage", count: state.byId.size };
  } catch (e) {
    setStatus({
      hydrated: true,
      loading: false,
      source: "memory",
      error: e?.message || String(e),
      lastLoadedAtISO: nowISO(),
    });
    notify();
    return { ok: false, storage: "memory", error: state.status.error };
  }
}

function getById(id) {
  const key = safeStr(id);
  const p = state.byId.get(key);
  return p ? safeClone(p) : null;
}

function list({
  householdId = "",
  status = "",
  tag = "",
  q = "",
  limit = 50,
  offset = 0,
} = {}) {
  const key = JSON.stringify({
    householdId: getHouseholdIdOrDefault(householdId),
    status: stableTrimLower(status),
    tag: stableTrimLower(tag),
    q: stableTrimLower(q),
    limit: Number(limit) || 50,
    offset: Number(offset) || 0,
  });

  // If query is identical, return last cached ids quickly
  if (state.lastList.key === key && state.lastList.ids?.length) {
    const plans = state.lastList.ids.map((id) => getById(id)).filter(Boolean);
    return { plans, total: plans.length, cached: true };
  }

  const all = getAllPlansArray().filter((p) =>
    matchesQuery(p, { householdId, status, tag, q })
  );

  const total = all.length;
  const off = Math.max(0, Number(offset) || 0);
  const lim = Math.max(1, Number(limit) || 50);
  const page = all.slice(off, off + lim);

  const ids = page.map((p) => p.id);
  state.lastList = { key, ids, atISO: nowISO() };

  return { plans: page.map((p) => safeClone(p)), total, cached: false };
}

function getActive({ householdId = "" } = {}) {
  const h = getHouseholdIdOrDefault(householdId);
  const id = ensureActiveForHousehold(h);
  return id ? getById(id) : null;
}

function setActive(id, { householdId = "" } = {}) {
  const planId = safeStr(id);
  if (!planId || !state.byId.has(planId))
    return { ok: false, error: "Plan not found" };

  const h = getHouseholdIdOrDefault(householdId);
  state.activeByHousehold[h] = planId;
  saveMetaToLocalStorage({ activeByHousehold: state.activeByHousehold });

  emit("mealplanstore.active_set", {
    source: SOURCE,
    householdId: h,
    id: planId,
    atISO: nowISO(),
  });
  notify();
  return { ok: true, id: planId, householdId: h };
}

function create(planPartial = {}) {
  const base = normalizePlan({
    id: makeId("mealplan"),
    title: "Meal Plan",
    description: "",
    status: "draft",
    tags: [],
    householdId:
      state.context.householdId || safeStr(planPartial.householdId || ""),
    ownerId: state.context.ownerId || safeStr(planPartial.ownerId || ""),
    timezone: planPartial.timezone || CONFIG.defaultTimezone,
    weekStartISO: planPartial.weekStartISO || nowISO(),
    days: {},
    constraints: {},
    rhythm: {},
    meta: { source: SOURCE, createdBy: "MealPlanStore.create" },
    createdAtISO: nowISO(),
    updatedAtISO: nowISO(),
    version: CONFIG.schemaVersion,
    ...planPartial,
  });

  state.byId.set(base.id, base);
  rebuildOrder();

  // if no active plan for household, set this as active
  const h = getHouseholdIdOrDefault(base.householdId);
  if (!state.activeByHousehold[h]) {
    state.activeByHousehold[h] = base.id;
    saveMetaToLocalStorage({ activeByHousehold: state.activeByHousehold });
  }

  markDirty("create");
  emit("mealplanstore.created", {
    source: SOURCE,
    id: base.id,
    householdId: h,
    atISO: nowISO(),
  });
  notify();

  return safeClone(base);
}

function upsert(plan) {
  const p = normalizePlan(plan);
  const existing = state.byId.get(p.id);
  const merged = existing ? deepMerge(existing, p) : p;
  merged.updatedAtISO = nowISO();
  state.byId.set(merged.id, merged);
  rebuildOrder();
  markDirty("upsert");
  emit("mealplanstore.upserted", {
    source: SOURCE,
    id: merged.id,
    atISO: merged.updatedAtISO,
  });
  notify();
  return safeClone(merged);
}

function update(id, patchOrUpdater) {
  const key = safeStr(id);
  const existing = state.byId.get(key);
  if (!existing) return { ok: false, error: "Plan not found" };

  const patch =
    typeof patchOrUpdater === "function"
      ? patchOrUpdater(safeClone(existing))
      : patchOrUpdater;

  const merged = normalizePlan(
    deepMerge(existing, isObject(patch) ? patch : {})
  );
  merged.id = existing.id; // never change id
  merged.createdAtISO = existing.createdAtISO || merged.createdAtISO;
  merged.updatedAtISO = nowISO();

  state.byId.set(key, merged);
  rebuildOrder();

  markDirty("update");
  emit("mealplanstore.updated", {
    source: SOURCE,
    id: key,
    atISO: merged.updatedAtISO,
  });
  notify();

  return { ok: true, plan: safeClone(merged) };
}

function remove(id) {
  const key = safeStr(id);
  if (!state.byId.has(key)) return { ok: false, error: "Plan not found" };

  // remove references
  state.byId.delete(key);
  state.order = state.order.filter((x) => x !== key);

  // clear active pointers
  for (const h of Object.keys(state.activeByHousehold)) {
    if (state.activeByHousehold[h] === key) delete state.activeByHousehold[h];
  }
  saveMetaToLocalStorage({ activeByHousehold: state.activeByHousehold });

  markDirty("remove");
  emit("mealplanstore.removed", { source: SOURCE, id: key, atISO: nowISO() });
  notify();

  return { ok: true };
}

function setDayPick(planId, dayKey, slot, pick) {
  const id = safeStr(planId);
  const plan = state.byId.get(id);
  if (!plan) return { ok: false, error: "Plan not found" };

  const day = safeStr(dayKey) || toISODateOnly(nowISO());
  const s = stableTrimLower(slot);
  if (!["breakfast", "lunch", "dinner", "snacks"].includes(s)) {
    return { ok: false, error: "Invalid slot" };
  }

  const days = isObject(plan.days) ? plan.days : {};
  const dayObj = isObject(days[day]) ? days[day] : {};

  const nextPick = pick == null ? null : safeClone(pick);

  const nextDayObj = { ...dayObj };
  if (s === "snacks") {
    // snacks can be array or single; normalize to array if passed array
    nextDayObj.snacks = Array.isArray(nextPick)
      ? nextPick
      : nextPick
      ? [nextPick]
      : [];
  } else {
    nextDayObj[s] = nextPick;
  }

  const nextDays = { ...days, [day]: nextDayObj };

  const merged = { ...plan, days: nextDays, updatedAtISO: nowISO() };
  state.byId.set(id, normalizePlan(merged));
  rebuildOrder();

  markDirty("setDayPick");
  emit("mealplanstore.day_pick_set", {
    source: SOURCE,
    id,
    day,
    slot: s,
    atISO: nowISO(),
  });
  notify();

  return { ok: true };
}

function setDayNotes(planId, dayKey, notes) {
  const id = safeStr(planId);
  const plan = state.byId.get(id);
  if (!plan) return { ok: false, error: "Plan not found" };

  const day = safeStr(dayKey) || toISODateOnly(nowISO());
  const days = isObject(plan.days) ? plan.days : {};
  const dayObj = isObject(days[day]) ? days[day] : {};

  const nextDayObj = { ...dayObj, notes: safeStr(notes || "") };
  const nextDays = { ...days, [day]: nextDayObj };

  const merged = { ...plan, days: nextDays, updatedAtISO: nowISO() };
  state.byId.set(id, normalizePlan(merged));
  rebuildOrder();

  markDirty("setDayNotes");
  emit("mealplanstore.day_notes_set", {
    source: SOURCE,
    id,
    day,
    atISO: nowISO(),
  });
  notify();

  return { ok: true };
}

async function persistNow() {
  if (!state.status.dirty) {
    return { ok: true, skipped: true, reason: "not-dirty" };
  }

  const plans = getAllPlansArray().map((p) => normalizePlan(p));
  const atISO = nowISO();

  // Try Dexie first
  let saved = false;
  try {
    saved = await saveToDexie(plans);
  } catch {
    saved = false;
  }

  if (saved) {
    setStatus({
      dirty: false,
      persisted: true,
      source: state.status.source === "dexie" ? "dexie" : state.status.source,
      lastSavedAtISO: atISO,
      error: null,
    });
    await emit("mealplanstore.persisted", {
      source: SOURCE,
      storage: "dexie",
      count: plans.length,
      atISO,
    });
    return { ok: true, storage: "dexie", count: plans.length };
  }

  // Fallback localStorage
  const ok = saveToLocalStorage(plans);
  if (ok) {
    setStatus({
      dirty: false,
      persisted: true,
      source: "localStorage",
      lastSavedAtISO: atISO,
      error: null,
    });
    await emit("mealplanstore.persisted", {
      source: SOURCE,
      storage: "localStorage",
      count: plans.length,
      atISO,
    });
    return { ok: true, storage: "localStorage", count: plans.length };
  }

  // Failure
  setStatus({
    persisted: false,
    lastSavedAtISO: atISO,
    error: "Failed to persist meal plans (Dexie and localStorage).",
  });
  await emit("mealplanstore.persist_failed", { source: SOURCE, atISO });
  return { ok: false, error: state.status.error };
}

function exportPlan(id) {
  const plan = getById(id);
  if (!plan) return { ok: false, error: "Plan not found" };

  const blob = {
    exportKind: "ssa.mealplan",
    exportVersion: CONFIG.schemaVersion,
    exportedAtISO: nowISO(),
    plan,
  };

  return { ok: true, blob };
}

function importPlan(blobOrObject, { activate = false } = {}) {
  const obj = isObject(blobOrObject)
    ? blobOrObject
    : (() => {
        try {
          return JSON.parse(String(blobOrObject || ""));
        } catch {
          return null;
        }
      })();

  if (!obj) return { ok: false, error: "Invalid import payload" };

  const planRaw = obj.plan ? obj.plan : obj;
  const plan = normalizePlan(planRaw);

  // If collision, make a new id (do not overwrite silently)
  if (state.byId.has(plan.id)) {
    plan.id = makeId("mealplan");
    plan.meta = { ...(plan.meta || {}), importedCollision: true };
  }

  plan.createdAtISO = plan.createdAtISO || nowISO();
  plan.updatedAtISO = nowISO();
  plan.meta = { ...(plan.meta || {}), source: SOURCE, importedAtISO: nowISO() };

  state.byId.set(plan.id, plan);
  rebuildOrder();

  if (activate) {
    const h = getHouseholdIdOrDefault(plan.householdId);
    state.activeByHousehold[h] = plan.id;
    saveMetaToLocalStorage({ activeByHousehold: state.activeByHousehold });
  }

  markDirty("import");
  emit("mealplanstore.imported", {
    source: SOURCE,
    id: plan.id,
    atISO: nowISO(),
  });
  notify();

  return { ok: true, plan: safeClone(plan) };
}

function reset({ keepStorage = false } = {}) {
  state.byId.clear();
  state.order = [];
  state.activeByHousehold = {};
  state.lastList = { key: "", ids: [], atISO: "" };

  setStatus({
    hydrated: false,
    loading: false,
    error: null,
    dirty: false,
    persisted: false,
    source: "memory",
    lastLoadedAtISO: "",
    lastSavedAtISO: "",
  });

  if (!keepStorage) {
    try {
      localStorage.removeItem(CONFIG.lsKey);
      localStorage.removeItem(CONFIG.lsMetaKey);
    } catch {
      // ignore
    }
  }

  emit("mealplanstore.reset", { source: SOURCE, keepStorage, atISO: nowISO() });
  notify();
  return { ok: true };
}

/* ------------------------------ convenience API ----------------------------- */
/**
 * Apply a suggestion result (from MealSuggestionService.suggestDay / suggestWeek)
 * into a plan by setting day picks. This is optional sugar for wiring.
 */
function applySuggestionToPlan(planId, suggestion) {
  const id = safeStr(planId);
  const plan = state.byId.get(id);
  if (!plan) return { ok: false, error: "Plan not found" };

  const s = isObject(suggestion) ? suggestion : null;
  if (!s) return { ok: false, error: "Invalid suggestion payload" };

  const dateISO = safeStr(s.dateISO || "");
  const dayKey = toISODateOnly(dateISO) || toISODateOnly(nowISO());
  const chosen = isObject(s.chosen) ? s.chosen : {};

  const slots = ["breakfast", "lunch", "dinner"];
  for (const slot of slots) {
    if (chosen[slot]) setDayPick(id, dayKey, slot, chosen[slot]);
  }

  // snacks
  if (chosen.snacks) setDayPick(id, dayKey, "snacks", chosen.snacks);

  // attach constraint notes optionally
  if (isObject(s.meta?.guards)) {
    update(id, (p) => ({
      constraints: deepMerge(p.constraints || {}, {
        lastGuards: s.meta.guards,
      }),
    }));
  }

  emit("mealplanstore.suggestion_applied", {
    source: SOURCE,
    id,
    day: dayKey,
    atISO: nowISO(),
  });
  return { ok: true, day: dayKey };
}

/* -------------------------------------------------------------------------- */
/* Compatibility exports (domain planners expect these named functions)         */
/* -------------------------------------------------------------------------- */

/**
 * saveMealPlan
 * -----------------------------------------------------------------------------
 * Compatibility wrapper for older UI code that expects:
 *   import { saveMealPlan, loadLatestMealPlan } from "@/services/meals/MealPlanStore"
 *
 * Behavior:
 *  - If plan has an id (and exists), updates via upsert().
 *  - Otherwise creates a new plan via create().
 *  - Optional: setActive + persistNow (default true).
 */
async function saveMealPlan(plan, opts = {}) {
  const options = isObject(opts) ? opts : {};
  const householdId = safeStr(options.householdId || plan?.householdId || "");
  const makeActive = options.makeActive !== false; // default true
  const persist = options.persist !== false; // default true

  const incoming = isObject(plan) ? plan : {};
  const normalized = normalizePlan(incoming);

  const exists = normalized?.id && state.byId.has(normalized.id);
  const saved = exists ? upsert(normalized) : create(normalized);

  if (makeActive) {
    try {
      setActive(saved.id, { householdId: householdId || saved.householdId });
    } catch {
      // ignore
    }
  }

  if (persist) {
    try {
      await persistNow();
    } catch {
      // ignore
    }
  }

  emit("mealplanstore.saved", {
    source: SOURCE,
    id: saved.id,
    householdId: getHouseholdIdOrDefault(householdId || saved.householdId),
    atISO: nowISO(),
  });

  return { ok: true, plan: safeClone(saved) };
}

/**
 * loadLatestMealPlan
 * -----------------------------------------------------------------------------
 * Compatibility wrapper:
 *  - Returns active plan for household if available,
 *    else most recently updated plan for that household,
 *    else null.
 */
async function loadLatestMealPlan({ householdId = "" } = {}) {
  const h = getHouseholdIdOrDefault(householdId);

  // If not hydrated yet, we still try to pick from in-memory; caller can call hydrate elsewhere.
  const active = getActive({ householdId: h });
  if (active) return { ok: true, plan: active, source: "active" };

  const all = getAllPlansArray().filter(
    (p) => getHouseholdIdOrDefault(p.householdId) === h
  );
  const latest = all[0] ? safeClone(all[0]) : null;

  return { ok: true, plan: latest, source: latest ? "latest" : "none" };
}

/* ------------------------------ exported object ----------------------------- */
const MealPlanStore = {
  SOURCE,

  // state
  getState,
  subscribe,

  // lifecycle
  hydrate,
  persistNow,
  reset,

  // CRUD
  list,
  getById,
  getActive,
  setActive,
  create,
  update,
  upsert,
  remove,

  // day editing
  setDayPick,
  setDayNotes,

  // import/export
  exportPlan,
  importPlan,

  // helpers
  normalizePlan,
  applySuggestionToPlan,

  // compatibility
  saveMealPlan,
  loadLatestMealPlan,
};

export default MealPlanStore;
export {
  getState,
  subscribe,
  hydrate,
  persistNow,
  reset,
  list,
  getById,
  getActive,
  setActive,
  create,
  update,
  upsert,
  remove,
  setDayPick,
  setDayNotes,
  exportPlan,
  importPlan,
  normalizePlan,
  applySuggestionToPlan,
  saveMealPlan,
  loadLatestMealPlan,
};
