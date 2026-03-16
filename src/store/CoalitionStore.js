// File: C:\Users\larho\suka-smart-assistant\src\store\CoalitionStore.js
/**
 * CoalitionStore (SSA)
 * -----------------------------------------------------------------------------
 * Purpose
 *  - Manage "coalitions": a higher-level network of groups (households, teams,
 *    circles, mutual-aid funds) that collaborate while remaining autonomous.
 *
 * Why "coalition" vs "group"
 *  - GroupStore = one coherent group with members and roles.
 *  - CoalitionStore = a federation of groups + agreements + shared resources.
 *
 * Design goals
 *  - Browser-safe, Vite-friendly (no Node imports).
 *  - Works with or without Dexie:
 *      • If Dexie has "coalitions" table, it persists there.
 *      • Else localStorage fallback; else in-memory.
 *  - Event-bus friendly:
 *      • Emits: coalitions.changed, coalitions.hydrated, coalitions.active.changed
 *
 * Recommended coalition shape (tolerant; extra fields allowed):
 *  {
 *    id: string,
 *    title: string,
 *    kind: "mutual_aid"|"trade_network"|"defense"|"education"|"custom",
 *    description?: string,
 *    memberGroupIds: string[],            // references GroupStore groups
 *    coordinators?: [{ id, name, email?, phone?, role? }],
 *    agreements?: [{
 *      id, title, type: "mou"|"sop"|"policy"|"deal",
 *      status: "draft"|"active"|"paused"|"retired",
 *      effectiveISO?, expiresISO?,
 *      terms?: object,
 *      tags?: string[]
 *    }],
 *    sharedResources?: [{
 *      id, type: "tool"|"space"|"vehicle"|"skills"|"inventory"|"fund",
 *      title, description?, availability?, meta?
 *    }],
 *    channels?: { chat?: string, emailAlias?: string, calendarId?: string },
 *    tags?: string[],
 *    active?: boolean,
 *    createdAtISO: string,
 *    updatedAtISO: string,
 *    meta?: object
 *  }
 */

const SOURCE = "store.CoalitionStore";
const STORAGE_KEY = "ssa.coalitions.v1";

/* -----------------------------------------------------------------------------
 * Optional deps (safe)
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

function stableId(prefix = "coal") {
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

function normalizeCoordinator(c) {
  const x = safeObj(c);
  const id = String(
    x.id || keyOf(x.email) || keyOf(x.phone) || stableId("coord")
  );
  return {
    id,
    name: x.name ? String(x.name) : "",
    email: x.email ? String(x.email) : "",
    phone: x.phone ? String(x.phone) : "",
    role: x.role ? String(x.role) : "",
    tags: safeArr(x.tags).map(String),
    meta: safeObj(x.meta),
  };
}

function normalizeAgreement(a) {
  const x = safeObj(a);
  const id = String(x.id || stableId("agr"));
  return {
    id,
    title: x.title ? String(x.title) : "Agreement",
    type: x.type ? String(x.type) : "policy",
    status: x.status ? String(x.status) : "draft",
    effectiveISO: x.effectiveISO ? String(x.effectiveISO) : "",
    expiresISO: x.expiresISO ? String(x.expiresISO) : "",
    terms: safeObj(x.terms),
    tags: safeArr(x.tags).map(String),
    meta: safeObj(x.meta),
  };
}

function normalizeResource(r) {
  const x = safeObj(r);
  const id = String(x.id || stableId("res"));
  return {
    id,
    type: x.type ? String(x.type) : "tool",
    title: x.title ? String(x.title) : "Resource",
    description: x.description ? String(x.description) : "",
    availability: safeObj(x.availability),
    tags: safeArr(x.tags).map(String),
    meta: safeObj(x.meta),
  };
}

function normalizeCoalition(coalition, { keepId = true } = {}) {
  const x = safeObj(coalition);
  const id = keepId ? String(x.id || "") : "";
  const finalId = id || String(x.id || stableId("coal"));

  const createdAtISO = x.createdAtISO
    ? String(x.createdAtISO)
    : x.createdAt
    ? String(x.createdAt)
    : nowISO();
  const updatedAtISO = nowISO();

  return {
    ...safeObj(x),
    id: finalId,
    title: x.title ? String(x.title) : "Coalition",
    kind: x.kind ? String(x.kind) : "custom",
    description: x.description ? String(x.description) : "",
    memberGroupIds: safeArr(x.memberGroupIds || x.groups || x.memberGroups)
      .map(String)
      .filter(Boolean),
    coordinators: safeArr(x.coordinators).map(normalizeCoordinator),
    agreements: safeArr(x.agreements).map(normalizeAgreement),
    sharedResources: safeArr(x.sharedResources || x.resources).map(
      normalizeResource
    ),
    channels: safeObj(x.channels),
    tags: safeArr(x.tags).map(String),
    active: typeof x.active === "boolean" ? x.active : undefined,
    createdAtISO,
    updatedAtISO,
    meta: safeObj(x.meta),
    source: x.source || SOURCE,
  };
}

function sortCoalitions(list) {
  const arr = safeArr(list).slice();
  arr.sort((a, b) => {
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
    if (!raw) return { coalitions: [], activeCoalitionId: null };
    const parsed = JSON.parse(raw);
    return {
      coalitions: safeArr(parsed.coalitions),
      activeCoalitionId: parsed.activeCoalitionId
        ? String(parsed.activeCoalitionId)
        : null,
    };
  } catch {
    return { coalitions: [], activeCoalitionId: null };
  }
}

function saveLS(state) {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        v: 1,
        savedAtISO: nowISO(),
        coalitions: safeArr(state.coalitions),
        activeCoalitionId: state.activeCoalitionId
          ? String(state.activeCoalitionId)
          : null,
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

  coalitions: [],
  activeCoalitionId: null,

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
    coalitions: sortCoalitions(_state.coalitions),
    activeCoalitionId: _state.activeCoalitionId,
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

async function getCoalitionsTable(db) {
  try {
    if (!db) return null;
    if (db.coalitions) return db.coalitions;
    if (typeof db.table === "function") return db.table("coalitions");
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
    const t = await getCoalitionsTable(db);
    if (t && typeof t.toArray === "function") {
      const all = await t.toArray();
      const coalitions = safeArr(all).map((c) =>
        normalizeCoalition(c, { keepId: true })
      );

      let activeCoalitionId = _state.activeCoalitionId;
      const active = coalitions.find((c) => c.active === true);
      if (active) activeCoalitionId = active.id;

      _set({
        coalitions,
        activeCoalitionId: activeCoalitionId || null,
        hydrated: true,
        loading: false,
        source: "dexie",
        lastLoadedAtISO: nowISO(),
      });

      emit(bus, "coalitions.hydrated", {
        at: _state.lastLoadedAtISO,
        source: "dexie",
        count: coalitions.length,
      });
      return getSnapshot();
    }
  } catch (e) {
    _set({ error: e?.message || String(e) });
  }

  // localStorage fallback
  try {
    const ls = loadLS();
    const coalitions = safeArr(ls.coalitions).map((c) =>
      normalizeCoalition(c, { keepId: true })
    );
    _set({
      coalitions,
      activeCoalitionId: ls.activeCoalitionId || null,
      hydrated: true,
      loading: false,
      source: "localStorage",
      lastLoadedAtISO: nowISO(),
    });

    emit(bus, "coalitions.hydrated", {
      at: _state.lastLoadedAtISO,
      source: "localStorage",
      count: coalitions.length,
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
    emit(bus, "coalitions.hydrated", {
      at: _state.lastLoadedAtISO,
      source: "memory",
      count: _state.coalitions.length,
    });
    return getSnapshot();
  }
}

async function persistNow() {
  const { bus, db } = await getDeps();
  const coalitions = safeArr(_state.coalitions);

  // Dexie
  try {
    const t = await getCoalitionsTable(db);
    if (t && typeof t.bulkPut === "function") {
      await t.bulkPut(coalitions);
      _set({ lastSavedAtISO: nowISO(), source: "dexie" });
      emit(bus, "coalitions.persisted", {
        at: _state.lastSavedAtISO,
        source: "dexie",
        count: coalitions.length,
      });
      return { ok: true, source: "dexie" };
    }
  } catch (e) {
    _set({ error: e?.message || String(e) });
  }

  // localStorage
  const ok = saveLS({
    coalitions,
    activeCoalitionId: _state.activeCoalitionId,
  });
  _set({
    lastSavedAtISO: nowISO(),
    source: ok ? "localStorage" : _state.source,
  });
  emit(bus, "coalitions.persisted", {
    at: _state.lastSavedAtISO,
    source: ok ? "localStorage" : _state.source,
    count: coalitions.length,
  });
  return { ok, source: ok ? "localStorage" : _state.source };
}

/* -----------------------------------------------------------------------------
 * CRUD
 * -------------------------------------------------------------------------- */

function getAll() {
  return sortCoalitions(_state.coalitions);
}

function getById(id) {
  const cid = String(id || "");
  if (!cid) return null;
  return _state.coalitions.find((c) => String(c.id) === cid) || null;
}

function getActiveCoalition() {
  if (_state.activeCoalitionId) return getById(_state.activeCoalitionId);
  return _state.coalitions[0] || null;
}

function setActiveCoalition(id) {
  const cid = String(id || "");
  if (cid && !getById(cid)) return null;

  const coalitions = _state.coalitions.map((c) => ({
    ...c,
    active: cid ? c.id === cid : false,
    updatedAtISO: nowISO(),
  }));

  _set({ coalitions, activeCoalitionId: cid || null });

  getDeps().then(({ bus }) => {
    emit(bus, "coalitions.active.changed", {
      activeCoalitionId: _state.activeCoalitionId,
      at: nowISO(),
    });
  });

  persistNow().catch(() => {});
  return getActiveCoalition();
}

function upsert(coalitionOrPartial) {
  const incoming = normalizeCoalition(coalitionOrPartial, { keepId: true });
  const existing = getById(incoming.id);

  const next = existing
    ? (() => {
        const merged = deepMerge(existing, incoming);
        merged.createdAtISO = existing.createdAtISO || incoming.createdAtISO;
        merged.updatedAtISO = nowISO();
        return merged;
      })()
    : incoming;

  const coalitions = _state.coalitions.filter((c) => c.id !== next.id);
  coalitions.push(next);

  let activeCoalitionId = _state.activeCoalitionId;
  if (!activeCoalitionId) activeCoalitionId = next.id;

  _set({ coalitions, activeCoalitionId });

  getDeps().then(({ bus }) => {
    emit(bus, "coalitions.changed", {
      type: existing ? "upsert" : "create",
      coalitionId: next.id,
      at: nowISO(),
    });
  });

  persistNow().catch(() => {});
  return next;
}

function createCoalition({
  title,
  kind = "custom",
  description = "",
  memberGroupIds = [],
  tags = [],
  meta = {},
} = {}) {
  const c = normalizeCoalition(
    {
      id: stableId("coal"),
      title: title || "New Coalition",
      kind,
      description,
      memberGroupIds,
      tags,
      meta,
    },
    { keepId: true }
  );
  return upsert(c);
}

function removeCoalition(id) {
  const cid = String(id || "");
  if (!cid) return false;

  const before = _state.coalitions.length;
  const coalitions = _state.coalitions.filter((c) => c.id !== cid);

  let activeCoalitionId = _state.activeCoalitionId;
  if (activeCoalitionId === cid) {
    activeCoalitionId = coalitions[0]?.id || null;
    for (const c of coalitions) c.active = c.id === activeCoalitionId;
  }

  _set({ coalitions, activeCoalitionId });

  const changed = before !== coalitions.length;
  if (changed) {
    getDeps().then(({ bus }) => {
      emit(bus, "coalitions.changed", {
        type: "remove",
        coalitionId: cid,
        at: nowISO(),
      });
      emit(bus, "coalitions.active.changed", {
        activeCoalitionId,
        at: nowISO(),
      });
    });
    persistNow().catch(() => {});
  }

  return changed;
}

/* -----------------------------------------------------------------------------
 * Membership operations (group federation)
 * -------------------------------------------------------------------------- */

function addGroupToCoalition(coalitionId, groupId) {
  const c = getById(coalitionId);
  if (!c) return null;

  const gid = String(groupId || "");
  if (!gid) return c;

  const set = new Set(safeArr(c.memberGroupIds).map(String));
  set.add(gid);

  const next = {
    ...c,
    memberGroupIds: Array.from(set),
    updatedAtISO: nowISO(),
  };
  return upsert(next);
}

function removeGroupFromCoalition(coalitionId, groupId) {
  const c = getById(coalitionId);
  if (!c) return null;

  const gid = String(groupId || "");
  if (!gid) return c;

  const next = {
    ...c,
    memberGroupIds: safeArr(c.memberGroupIds)
      .map(String)
      .filter((x) => x !== gid),
    updatedAtISO: nowISO(),
  };
  return upsert(next);
}

/* -----------------------------------------------------------------------------
 * Agreement operations
 * -------------------------------------------------------------------------- */

function addAgreement(coalitionId, agreement) {
  const c = getById(coalitionId);
  if (!c) return null;

  const agr = normalizeAgreement(agreement);
  const next = {
    ...c,
    agreements: [...safeArr(c.agreements), agr],
    updatedAtISO: nowISO(),
  };
  return upsert(next);
}

function updateAgreement(coalitionId, agreementId, patch) {
  const c = getById(coalitionId);
  if (!c) return null;

  const aid = String(agreementId || "");
  if (!aid) return c;

  const agreements = safeArr(c.agreements).map((a) =>
    String(a.id) === aid ? deepMerge(a, safeObj(patch)) : a
  );
  const next = { ...c, agreements, updatedAtISO: nowISO() };
  return upsert(next);
}

function removeAgreement(coalitionId, agreementId) {
  const c = getById(coalitionId);
  if (!c) return null;

  const aid = String(agreementId || "");
  if (!aid) return c;

  const agreements = safeArr(c.agreements).filter((a) => String(a.id) !== aid);
  const next = { ...c, agreements, updatedAtISO: nowISO() };
  return upsert(next);
}

/* -----------------------------------------------------------------------------
 * Shared resource operations
 * -------------------------------------------------------------------------- */

function addSharedResource(coalitionId, resource) {
  const c = getById(coalitionId);
  if (!c) return null;

  const res = normalizeResource(resource);
  const next = {
    ...c,
    sharedResources: [...safeArr(c.sharedResources), res],
    updatedAtISO: nowISO(),
  };
  return upsert(next);
}

function updateSharedResource(coalitionId, resourceId, patch) {
  const c = getById(coalitionId);
  if (!c) return null;

  const rid = String(resourceId || "");
  if (!rid) return c;

  const resources = safeArr(c.sharedResources).map((r) =>
    String(r.id) === rid ? deepMerge(r, safeObj(patch)) : r
  );
  const next = { ...c, sharedResources: resources, updatedAtISO: nowISO() };
  return upsert(next);
}

function removeSharedResource(coalitionId, resourceId) {
  const c = getById(coalitionId);
  if (!c) return null;

  const rid = String(resourceId || "");
  if (!rid) return c;

  const resources = safeArr(c.sharedResources).filter(
    (r) => String(r.id) !== rid
  );
  const next = { ...c, sharedResources: resources, updatedAtISO: nowISO() };
  return upsert(next);
}

/* -----------------------------------------------------------------------------
 * External store facade
 * -------------------------------------------------------------------------- */

const CoalitionStore = {
  // status
  hydrate,
  persistNow,
  getSnapshot,
  subscribe,

  // base
  getAll,
  getById,
  getActiveCoalition,
  setActiveCoalition,
  createCoalition,
  upsert,
  removeCoalition,

  // federation
  addGroupToCoalition,
  removeGroupFromCoalition,

  // agreements
  addAgreement,
  updateAgreement,
  removeAgreement,

  // resources
  addSharedResource,
  updateSharedResource,
  removeSharedResource,

  // diagnostics
  _unsafeState: _state,
};

export default CoalitionStore;
export { CoalitionStore };
