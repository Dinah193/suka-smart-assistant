// File: C:\Users\larho\suka-smart-assistant\src\store\GroupStore.js
/**
 * GroupStore (SSA)
 * -----------------------------------------------------------------------------
 * Purpose
 *  - Manage "groups" across SSA (households, squads, circles, teams, roles).
 *  - Provide a browser-safe external-store interface for React (useSyncExternalStore),
 *    plus a simple async API for non-React callers.
 *
 * Design goals
 *  - No Node imports; safe for Vite builds.
 *  - Works with or without Dexie DB:
 *      • If src/services/db exports a Dexie instance with a "groups" table, we persist.
 *      • Otherwise we fall back to localStorage (and in-memory as last resort).
 *  - EventBus-friendly:
 *      • Emits: groups.changed, groups.member.changed, groups.active.changed
 *  - Idempotent & deterministic:
 *      • Upsert by id; stable sort by updatedAt/title.
 *
 * What is a "group"?
 *  - A collection of members with optional roles and metadata.
 *  - Examples:
 *      • Household group (primary)
 *      • Cleaning crew
 *      • Susu circle
 *      • Garden team
 *
 * Group shape (recommended)
 *  {
 *    id: string,
 *    kind: "household"|"team"|"circle"|"custom",
 *    title: string,
 *    description?: string,
 *    members: [
 *      { id: string, name?: string, email?: string, phone?: string, role?: string, tags?: string[] }
 *    ],
 *    roles?: [{ id: string, title: string, permissions?: string[] }],
 *    tags?: string[],
 *    active?: boolean,          // optional
 *    createdAt: ISO,
 *    updatedAt: ISO,
 *    meta?: object
 *  }
 *
 * -----------------------------------------------------------------------------
 */

const SOURCE = "store.GroupStore";
const STORAGE_KEY = "ssa.groups.v1";

/* -----------------------------------------------------------------------------
 * Optional deps (safe)
 * -------------------------------------------------------------------------- */

let bus = null;
try {
  // Prefer your services event bus if present
  const mod = await import("../services/automation/eventBus.js").catch(
    () => null
  );
  bus =
    mod?.eventBus || mod?.bus || mod?.default?.eventBus || mod?.default || null;
} catch {
  bus = null;
}

function emit(event, payload) {
  try {
    if (!bus) return;
    if (typeof bus.emit === "function") bus.emit(event, payload);
    else if (typeof bus.publish === "function") bus.publish(event, payload);
  } catch {
    /* no-op */
  }
}

// Dexie DB optional
let db = null;
try {
  // Most SSA projects export from src/services/db.js
  const mod = await import("../services/db.js").catch(() => null);
  db = mod?.db || mod?.default || mod || null;
} catch {
  db = null;
}

function hasGroupsTable(d) {
  try {
    return !!(d && (d.groups || d.table?.("groups")));
  } catch {
    return false;
  }
}

async function dbTable() {
  if (!db) return null;
  if (db.groups) return db.groups;
  if (typeof db.table === "function") return db.table("groups");
  return null;
}

/* -----------------------------------------------------------------------------
 * Utilities
 * -------------------------------------------------------------------------- */

const isObj = (x) => x && typeof x === "object" && !Array.isArray(x);
const safeObj = (x) => (isObj(x) ? x : {});
const safeArr = (x) => (Array.isArray(x) ? x : []);

const keyOf = (s) =>
  String(s || "")
    .trim()
    .toLowerCase()
    .replace(/[^\w]+/g, "_")
    .replace(/^_+|_+$/g, "");

const nowISO = () => new Date().toISOString();

function stableId(prefix = "grp") {
  // deterministic-ish, collision-resistant enough for local usage
  return `${prefix}_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

function sortGroups(list) {
  const arr = safeArr(list).slice();
  arr.sort((a, b) => {
    const ua = String(a?.updatedAt || "");
    const ub = String(b?.updatedAt || "");
    if (ub !== ua) return ub.localeCompare(ua);
    const ta = String(a?.title || "");
    const tb = String(b?.title || "");
    return ta.localeCompare(tb);
  });
  return arr;
}

function normalizeMember(m) {
  const x = safeObj(m);
  const id = String(x.id || keyOf(x.email) || keyOf(x.phone) || "");
  return {
    id: id || stableId("mem"),
    name: x.name ? String(x.name) : "",
    email: x.email ? String(x.email) : "",
    phone: x.phone ? String(x.phone) : "",
    role: x.role ? String(x.role) : "",
    tags: safeArr(x.tags).map(String),
    meta: safeObj(x.meta),
  };
}

function normalizeGroup(g, { keepId } = {}) {
  const x = safeObj(g);
  const id = keepId ? String(x.id || "") : String(x.id || stableId("grp"));

  const kind = x.kind ? String(x.kind) : "custom";
  const title = x.title ? String(x.title) : "Group";
  const description = x.description ? String(x.description) : "";

  const createdAt = x.createdAt ? String(x.createdAt) : nowISO();
  const updatedAt = nowISO();

  const members = safeArr(x.members).map(normalizeMember);
  const roles = safeArr(x.roles).map((r) => {
    const rr = safeObj(r);
    const rid = String(rr.id || keyOf(rr.title) || stableId("role"));
    return {
      id: rid,
      title: rr.title ? String(rr.title) : rid,
      permissions: safeArr(rr.permissions).map(String),
      meta: safeObj(rr.meta),
    };
  });

  return {
    id,
    kind,
    title,
    description,
    members,
    roles,
    tags: safeArr(x.tags).map(String),
    active: typeof x.active === "boolean" ? x.active : undefined,
    createdAt,
    updatedAt,
    meta: safeObj(x.meta),
    source: SOURCE,
  };
}

function loadFromLocalStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { groups: [], activeGroupId: null };
    const parsed = JSON.parse(raw);
    return {
      groups: safeArr(parsed.groups),
      activeGroupId: parsed.activeGroupId ? String(parsed.activeGroupId) : null,
    };
  } catch {
    return { groups: [], activeGroupId: null };
  }
}

function saveToLocalStorage(state) {
  try {
    const payload = {
      groups: safeArr(state.groups),
      activeGroupId: state.activeGroupId ? String(state.activeGroupId) : null,
      savedAt: nowISO(),
      v: 1,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
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

/* -----------------------------------------------------------------------------
 * Store state + subscribers
 * -------------------------------------------------------------------------- */

const _state = {
  hydrated: false,
  loading: false,
  error: null,

  groups: [],
  activeGroupId: null,

  // provenance
  source: "memory", // "dexie" | "localStorage" | "memory"
  lastLoadedAt: null,
  lastSavedAt: null,
};

const _subs = new Set();

function _notify() {
  for (const fn of _subs) {
    try {
      fn();
    } catch {
      /* ignore */
    }
  }
}

function _set(partial) {
  Object.assign(_state, partial);
  _notify();
}

function snapshot() {
  // return immutable-ish snapshot
  return {
    hydrated: _state.hydrated,
    loading: _state.loading,
    error: _state.error,

    groups: sortGroups(_state.groups),
    activeGroupId: _state.activeGroupId,

    source: _state.source,
    lastLoadedAt: _state.lastLoadedAt,
    lastSavedAt: _state.lastSavedAt,
  };
}

/* -----------------------------------------------------------------------------
 * Persistence layer
 * -------------------------------------------------------------------------- */

async function hydrate() {
  if (_state.hydrated || _state.loading) return snapshot();

  _set({ loading: true, error: null });

  // Try Dexie first
  try {
    const t = await dbTable();
    if (t && hasGroupsTable(db)) {
      const all = await t.toArray();
      // Expect a row shape similar to group object
      const groups = safeArr(all).map((g) =>
        normalizeGroup(g, { keepId: true })
      );
      // Determine active: prefer a single active flag, else keep prior activeGroupId
      let activeGroupId = _state.activeGroupId;
      const active = groups.find((g) => g.active === true);
      if (active) activeGroupId = active.id;

      _set({
        groups,
        activeGroupId: activeGroupId || null,
        hydrated: true,
        loading: false,
        source: "dexie",
        lastLoadedAt: nowISO(),
      });

      emit("groups.hydrated", {
        at: _state.lastLoadedAt,
        source: "dexie",
        count: groups.length,
      });
      return snapshot();
    }
  } catch (e) {
    // fall through to localStorage
    _set({ error: e?.message || String(e) });
  }

  // localStorage fallback
  try {
    const ls = loadFromLocalStorage();
    const groups = safeArr(ls.groups).map((g) =>
      normalizeGroup(g, { keepId: true })
    );
    _set({
      groups,
      activeGroupId: ls.activeGroupId || null,
      hydrated: true,
      loading: false,
      source: "localStorage",
      lastLoadedAt: nowISO(),
    });
    emit("groups.hydrated", {
      at: _state.lastLoadedAt,
      source: "localStorage",
      count: groups.length,
    });
    return snapshot();
  } catch (e) {
    _set({
      error: e?.message || String(e),
      hydrated: true,
      loading: false,
      source: "memory",
      lastLoadedAt: nowISO(),
    });
    emit("groups.hydrated", {
      at: _state.lastLoadedAt,
      source: "memory",
      count: _state.groups.length,
    });
    return snapshot();
  }
}

async function persistNow() {
  // If using Dexie, save there; else localStorage
  const groups = safeArr(_state.groups);

  // Dexie path
  try {
    const t = await dbTable();
    if (t && hasGroupsTable(db)) {
      await t.bulkPut(groups);
      _set({ lastSavedAt: nowISO(), source: "dexie" });
      emit("groups.persisted", {
        at: _state.lastSavedAt,
        source: "dexie",
        count: groups.length,
      });
      return { ok: true, source: "dexie" };
    }
  } catch (e) {
    _set({ error: e?.message || String(e) });
  }

  // localStorage fallback
  const ok = saveToLocalStorage({
    groups,
    activeGroupId: _state.activeGroupId,
  });
  _set({ lastSavedAt: nowISO(), source: ok ? "localStorage" : _state.source });
  emit("groups.persisted", {
    at: _state.lastSavedAt,
    source: ok ? "localStorage" : _state.source,
    count: groups.length,
  });
  return { ok, source: ok ? "localStorage" : _state.source };
}

/* -----------------------------------------------------------------------------
 * Core CRUD
 * -------------------------------------------------------------------------- */

function getAll() {
  return sortGroups(_state.groups);
}

function getById(id) {
  const gid = String(id || "");
  if (!gid) return null;
  return _state.groups.find((g) => String(g.id) === gid) || null;
}

function getActiveGroup() {
  if (_state.activeGroupId) return getById(_state.activeGroupId);
  // If none selected, prefer first household kind if exists
  const household = _state.groups.find((g) => keyOf(g.kind) === "household");
  return household || _state.groups[0] || null;
}

function setActiveGroup(id) {
  const gid = String(id || "");
  if (gid && !getById(gid)) return null;

  // mark active flags (optional)
  const groups = _state.groups.map((g) => ({
    ...g,
    active: gid ? g.id === gid : false,
    updatedAt: nowISO(),
  }));

  _set({ groups, activeGroupId: gid || null });
  emit("groups.active.changed", { activeGroupId: _state.activeGroupId });

  // persist best-effort
  persistNow().catch(() => {});
  return getActiveGroup();
}

function upsert(groupOrPartial) {
  const incoming = normalizeGroup(groupOrPartial, { keepId: true });
  const existing = getById(incoming.id);

  let next;
  if (existing) {
    // merge but keep createdAt
    next = deepMerge(existing, incoming);
    next.createdAt = existing.createdAt || incoming.createdAt;
    next.updatedAt = nowISO();
  } else {
    next = normalizeGroup(incoming, { keepId: true });
  }

  const groups = _state.groups.filter((g) => g.id !== next.id);
  groups.push(next);

  // If this is first group, set active
  let activeGroupId = _state.activeGroupId;
  if (!activeGroupId) activeGroupId = next.id;

  _set({ groups, activeGroupId });
  emit("groups.changed", { type: "upsert", groupId: next.id });

  persistNow().catch(() => {});
  return next;
}

function createGroup({ kind, title, description, members, tags, meta } = {}) {
  const g = normalizeGroup(
    {
      id: stableId("grp"),
      kind: kind || "custom",
      title: title || "New Group",
      description: description || "",
      members: safeArr(members),
      tags: safeArr(tags),
      meta: safeObj(meta),
    },
    { keepId: true }
  );
  return upsert(g);
}

function removeGroup(id) {
  const gid = String(id || "");
  if (!gid) return false;
  const before = _state.groups.length;
  const groups = _state.groups.filter((g) => g.id !== gid);

  // adjust active
  let activeGroupId = _state.activeGroupId;
  if (activeGroupId === gid) {
    activeGroupId = groups[0]?.id || null;
    // mark active flags
    for (const g of groups) g.active = g.id === activeGroupId;
  }

  _set({ groups, activeGroupId });
  const changed = before !== groups.length;

  if (changed) {
    emit("groups.changed", { type: "remove", groupId: gid });
    emit("groups.active.changed", { activeGroupId });
    persistNow().catch(() => {});
  }

  return changed;
}

/* -----------------------------------------------------------------------------
 * Member ops
 * -------------------------------------------------------------------------- */

function addMember(groupId, member) {
  const g = getById(groupId);
  if (!g) return null;

  const m = normalizeMember(member);
  const members = safeArr(g.members);
  if (members.some((x) => x.id === m.id)) return g;

  const next = {
    ...g,
    members: [...members, m],
    updatedAt: nowISO(),
  };

  upsert(next);
  emit("groups.member.changed", { type: "add", groupId: g.id, memberId: m.id });
  return getById(g.id);
}

function updateMember(groupId, memberId, patch) {
  const g = getById(groupId);
  if (!g) return null;

  const mid = String(memberId || "");
  if (!mid) return null;

  const members = safeArr(g.members).map((m) => {
    if (String(m.id) !== mid) return m;
    return deepMerge(m, safeObj(patch));
  });

  const next = { ...g, members, updatedAt: nowISO() };
  upsert(next);
  emit("groups.member.changed", {
    type: "update",
    groupId: g.id,
    memberId: mid,
  });
  return getById(g.id);
}

function removeMember(groupId, memberId) {
  const g = getById(groupId);
  if (!g) return null;

  const mid = String(memberId || "");
  if (!mid) return g;

  const members = safeArr(g.members).filter((m) => String(m.id) !== mid);
  const next = { ...g, members, updatedAt: nowISO() };

  upsert(next);
  emit("groups.member.changed", {
    type: "remove",
    groupId: g.id,
    memberId: mid,
  });
  return getById(g.id);
}

/* -----------------------------------------------------------------------------
 * External store interface (React-friendly)
 * -------------------------------------------------------------------------- */

function subscribe(fn) {
  _subs.add(fn);
  return () => _subs.delete(fn);
}

function getSnapshot() {
  return snapshot();
}

/* -----------------------------------------------------------------------------
 * Public facade
 * -------------------------------------------------------------------------- */

const GroupStore = {
  // status
  getSnapshot,
  subscribe,
  hydrate,
  persistNow,

  // group ops
  getAll,
  getById,
  getActiveGroup,
  setActiveGroup,
  createGroup,
  upsert,
  removeGroup,

  // member ops
  addMember,
  updateMember,
  removeMember,

  // convenience
  ensureHouseholdGroup({
    title = "Household",
    householdId = "primary",
    meta,
  } = {}) {
    // id stable for household
    const id = `household_${keyOf(householdId) || "primary"}`;
    const existing = getById(id);
    if (existing) return existing;

    const g = normalizeGroup(
      {
        id,
        kind: "household",
        title,
        members: [],
        tags: ["household"],
        active: true,
        meta: { householdId, ...safeObj(meta) },
      },
      { keepId: true }
    );

    const saved = upsert(g);
    setActiveGroup(saved.id);
    return saved;
  },

  // debug / tests
  _unsafeState: _state,
};

export default GroupStore;
export { GroupStore };
