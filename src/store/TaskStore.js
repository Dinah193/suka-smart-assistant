// File: src/store/TaskStore.js
/**
 * TaskStore (SSA)
 * -----------------------------------------------------------------------------
 * Purpose
 *  - Central, browser-safe task ledger for SSA: household tasks, session prep,
 *    follow-ups, and cross-domain work (cooking/cleaning/garden/animals/etc.).
 *
 * Design Goals
 *  - Production-safe: no Node APIs, no build-breaking imports.
 *  - Works without Dexie, but will use Dexie if a `tasks` table exists.
 *  - Event-driven: emits to SSA eventBus if available.
 *  - React-friendly: subscribe/getSnapshot for useSyncExternalStore.
 *  - Offline-first: localStorage persistence as a baseline.
 *
 * Key Concepts
 *  - A "task" is atomic work with status, due windows, tags, domain, and links.
 *  - "Plans" are just filtered views; no separate table required.
 *
 * Optional Integrations (best-effort)
 *  - Dexie: src/services/db.js exporting `db` with a `tasks` table.
 *  - eventBus: src/services/events/eventBus.js exporting `eventBus` (emit/on).
 *  - ReminderManager: src/services/notifications/ReminderManager.js for due alerts.
 */

/* --------------------------------- Constants -------------------------------- */

const STORE_NAME = "TaskStore";
const LS_KEY = "SSA.TaskStore.v1";
const SCHEMA_VERSION = 1;

const DEFAULTS = {
  version: SCHEMA_VERSION,
  hydrated: false,
  dirty: false,
  lastHydratedAt: null,
  lastPersistedAt: null,
  source: "local", // local | dexie | merged
  error: null,

  // Core
  tasksById: {}, // id -> Task
  order: [], // stable ordering (newest-first by default)

  // Simple user preferences for task views
  prefs: {
    defaultSort: "updatedDesc", // updatedDesc | dueAsc | priorityDesc | createdDesc | titleAsc
    hideCompleted: false,
    quietHours: {
      enabled: false,
      start: "22:00",
      end: "07:00",
    },
  },
};

/* ------------------------------- Type Helpers --------------------------------
Task shape (documented for consistency; not enforced at runtime):
{
  id: string,
  title: string,
  notes?: string,
  status: "todo"|"doing"|"done"|"blocked"|"snoozed",
  priority: 1|2|3|4|5,
  domain?: string,            // "household"|"cooking"|"cleaning"|"garden"|"animals"|...
  category?: string,          // "prep"|"followup"|"repair"|...
  tags?: string[],
  assignees?: string[],       // user ids or names
  createdAt: ISOString,
  updatedAt: ISOString,
  startsAt?: ISOString,
  dueAt?: ISOString,
  completedAt?: ISOString,
  snoozedUntil?: ISOString,
  estimateMin?: number,
  repeat?: {                  // optional recurrence hints (informational)
    rrule?: string,           // e.g., "FREQ=WEEKLY;BYDAY=MO,WE,FR"
    anchorISO?: string,
  },
  dependencies?: string[],    // ids of tasks that must be done first
  links?: {                   // cross-domain pointers
    sessionId?: string,
    artifactId?: string,
    blueprintId?: string,
    recipeIds?: string[],
    inventoryItemIds?: string[],
    animalIds?: string[],
    gardenBedIds?: string[],
  },
  notify?: {                  // reminder request
    enabled?: boolean,
    atISO?: string,           // if omitted, defaults to dueAt
    title?: string,
    body?: string,
    tag?: string,
    data?: any,
  },
  meta?: Record<string, any>,
}
----------------------------------------------------------------------------- */

/* -------------------------------- Utilities --------------------------------- */

function nowISO() {
  return new Date().toISOString();
}

function isObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function deepMerge(base, patch) {
  if (!isObject(base) || !isObject(patch)) return patch;
  const out = { ...base };
  for (const k of Object.keys(patch)) {
    const pv = patch[k];
    const bv = base[k];
    if (isObject(bv) && isObject(pv)) out[k] = deepMerge(bv, pv);
    else out[k] = pv;
  }
  return out;
}

function safeParseJSON(str, fallback) {
  try {
    const v = JSON.parse(str);
    return v ?? fallback;
  } catch {
    return fallback;
  }
}

function stableUnique(arr) {
  const seen = new Set();
  const out = [];
  for (const v of Array.isArray(arr) ? arr : []) {
    if (v == null) continue;
    const s = String(v);
    if (!seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  }
  return out;
}

function clampInt(n, min, max, fallback) {
  const x = Number(n);
  if (!Number.isFinite(x)) return fallback;
  const xi = Math.trunc(x);
  return Math.min(max, Math.max(min, xi));
}

function normalizeISO(maybeISO) {
  if (!maybeISO) return undefined;
  const d = new Date(maybeISO);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toISOString();
}

function createId(prefix = "task") {
  // collision-resistant enough for client-only usage
  return `${prefix}_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

function sortIds(state, ids, sortKey) {
  const tasksById = state.tasksById || {};
  const key = sortKey || state.prefs?.defaultSort || "updatedDesc";

  const get = (id) => tasksById[id];

  const cmpStr = (a, b) => (a || "").localeCompare(b || "");
  const cmpNum = (a, b) => (a || 0) - (b || 0);
  const cmpDateAsc = (a, b) => {
    const ta = a ? new Date(a).getTime() : Number.POSITIVE_INFINITY;
    const tb = b ? new Date(b).getTime() : Number.POSITIVE_INFINITY;
    return ta - tb;
  };
  const cmpDateDesc = (a, b) => {
    const ta = a ? new Date(a).getTime() : 0;
    const tb = b ? new Date(b).getTime() : 0;
    return tb - ta;
  };

  const f = {
    updatedDesc: (a, b) => cmpDateDesc(get(a)?.updatedAt, get(b)?.updatedAt),
    createdDesc: (a, b) => cmpDateDesc(get(a)?.createdAt, get(b)?.createdAt),
    dueAsc: (a, b) => cmpDateAsc(get(a)?.dueAt, get(b)?.dueAt),
    priorityDesc: (a, b) =>
      cmpNum(get(b)?.priority, get(a)?.priority) ||
      cmpDateDesc(get(a)?.updatedAt, get(b)?.updatedAt),
    titleAsc: (a, b) => cmpStr(get(a)?.title, get(b)?.title),
  }[key];

  const idsCopy = [...ids];
  idsCopy.sort((a, b) => (f ? f(a, b) : 0));
  return idsCopy;
}

/* --------------------------- Optional Dependencies --------------------------- */

async function tryLoadEventBus() {
  try {
    const mod = await import(/* @vite-ignore */ "@/services/events/eventBus");
    const eb = mod?.eventBus || mod?.default || null;
    if (!eb) return null;
    // expected shape: { emit(type,payload) } OR { publish(...) }
    return eb;
  } catch {
    return null;
  }
}

async function tryLoadDexieDB() {
  try {
    const mod = await import(/* @vite-ignore */ "@/services/db");
    const db = mod?.db || mod?.default || null;
    if (!db) return null;
    // We only use it if a "tasks" table exists with put/get/toArray/etc.
    if (!db.tasks) return null;
    return db;
  } catch {
    return null;
  }
}

async function tryLoadReminderManager() {
  try {
    const mod = await import(
      /* @vite-ignore */ "@/services/notifications/ReminderManager"
    );
    return mod?.default || mod?.ReminderManager || null;
  } catch {
    return null;
  }
}

/* --------------------------------- Store Core -------------------------------- */

function createStore() {
  let state = { ...DEFAULTS };
  const listeners = new Set();

  // lazy-loaded optional services
  let eventBus = null;
  let dexie = null;
  let reminders = null;

  function emitLocal() {
    for (const fn of listeners) {
      try {
        fn();
      } catch {
        // ignore subscriber errors
      }
    }
  }

  function setState(updater, meta = {}) {
    const prev = state;
    const next =
      typeof updater === "function" ? updater(prev) : deepMerge(prev, updater);

    // Maintain invariants
    const nextState = {
      ...next,
      tasksById: next.tasksById || {},
      order: Array.isArray(next.order) ? next.order : [],
      prefs: deepMerge(DEFAULTS.prefs, next.prefs || {}),
    };

    state = nextState;

    // Emit events (best-effort)
    if (eventBus && typeof eventBus.emit === "function") {
      try {
        eventBus.emit("tasks.changed", {
          source: STORE_NAME,
          at: nowISO(),
          meta,
        });
      } catch {
        // ignore
      }
    } else if (eventBus && typeof eventBus.publish === "function") {
      try {
        eventBus.publish("tasks.changed", {
          source: STORE_NAME,
          at: nowISO(),
          meta,
        });
      } catch {
        // ignore
      }
    }

    emitLocal();
  }

  function getState() {
    return state;
  }

  function subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  function getSnapshot() {
    return state;
  }

  /* ------------------------------ Persistence -------------------------------- */

  function loadFromLocalStorage() {
    if (typeof window === "undefined") return null;
    const raw = window.localStorage?.getItem?.(LS_KEY);
    if (!raw) return null;
    const parsed = safeParseJSON(raw, null);
    if (!parsed || typeof parsed !== "object") return null;

    // Basic validation / coercion
    const tasksById = isObject(parsed.tasksById) ? parsed.tasksById : {};
    const order = Array.isArray(parsed.order) ? parsed.order : [];

    return {
      ...DEFAULTS,
      ...parsed,
      tasksById,
      order,
      prefs: deepMerge(DEFAULTS.prefs, parsed.prefs || {}),
      hydrated: true,
      source: "local",
      error: null,
      lastHydratedAt: nowISO(),
      dirty: false,
    };
  }

  function saveToLocalStorage(snapshot) {
    if (typeof window === "undefined") return;
    try {
      const payload = {
        ...snapshot,
        // avoid storing transient error objects
        error: snapshot.error ? String(snapshot.error) : null,
      };
      window.localStorage?.setItem?.(LS_KEY, JSON.stringify(payload));
    } catch {
      // ignore localStorage errors (quota, private mode, etc.)
    }
  }

  async function loadFromDexieIfAvailable() {
    if (!dexie) return null;
    try {
      // Expect tasks table entries like: { id, ...task }
      const rows = await dexie.tasks.toArray();
      const tasksById = {};
      const order = [];
      for (const row of Array.isArray(rows) ? rows : []) {
        if (!row || !row.id) continue;
        tasksById[row.id] = normalizeTask(row, { keepTimestamps: true });
        order.push(row.id);
      }
      // Keep consistent ordering
      const sorted = sortIds(
        { ...state, tasksById, prefs: state.prefs },
        stableUnique(order),
        state.prefs?.defaultSort
      );

      return {
        ...DEFAULTS,
        ...state,
        tasksById,
        order: sorted,
        hydrated: true,
        source: "dexie",
        error: null,
        lastHydratedAt: nowISO(),
        dirty: false,
      };
    } catch (e) {
      return {
        ...state,
        hydrated: true,
        source: state.source || "local",
        error: e ? String(e) : "Dexie load failed",
        lastHydratedAt: nowISO(),
      };
    }
  }

  async function persistToDexie(snapshot) {
    if (!dexie) return false;
    try {
      const ids = Object.keys(snapshot.tasksById || {});
      // Batch put (Dexie supports bulkPut)
      if (typeof dexie.tasks.bulkPut === "function") {
        const rows = ids.map((id) => snapshot.tasksById[id]);
        await dexie.tasks.bulkPut(rows);
      } else {
        for (const id of ids) {
          await dexie.tasks.put(snapshot.tasksById[id]);
        }
      }
      return true;
    } catch {
      return false;
    }
  }

  /* ------------------------------ Normalization ------------------------------ */

  function normalizeTask(input, opts = {}) {
    const keep = !!opts.keepTimestamps;
    const base = isObject(input) ? { ...input } : {};

    const id = String(base.id || createId("task"));
    const createdAt = keep
      ? normalizeISO(base.createdAt) || nowISO()
      : normalizeISO(base.createdAt) || nowISO();

    const updatedAt = keep
      ? normalizeISO(base.updatedAt) || createdAt
      : nowISO();

    const statusRaw = String(base.status || "todo");
    const status = ["todo", "doing", "done", "blocked", "snoozed"].includes(
      statusRaw
    )
      ? statusRaw
      : "todo";

    const priority = clampInt(base.priority, 1, 5, 3);

    const tags = stableUnique(base.tags);
    const assignees = stableUnique(base.assignees);

    const dueAt = normalizeISO(base.dueAt);
    const startsAt = normalizeISO(base.startsAt);
    const completedAt = normalizeISO(base.completedAt);
    const snoozedUntil = normalizeISO(base.snoozedUntil);

    const dependencies = stableUnique(base.dependencies);

    const links = isObject(base.links) ? { ...base.links } : undefined;
    if (links) {
      if (Array.isArray(links.recipeIds))
        links.recipeIds = stableUnique(links.recipeIds);
      if (Array.isArray(links.inventoryItemIds))
        links.inventoryItemIds = stableUnique(links.inventoryItemIds);
      if (Array.isArray(links.animalIds))
        links.animalIds = stableUnique(links.animalIds);
      if (Array.isArray(links.gardenBedIds))
        links.gardenBedIds = stableUnique(links.gardenBedIds);
    }

    const notify = isObject(base.notify) ? { ...base.notify } : undefined;
    if (notify) {
      notify.enabled = !!notify.enabled;
      notify.atISO = normalizeISO(notify.atISO) || normalizeISO(dueAt);
      notify.title = notify.title ? String(notify.title) : undefined;
      notify.body = notify.body ? String(notify.body) : undefined;
      notify.tag = notify.tag ? String(notify.tag) : undefined;
    }

    const repeat = isObject(base.repeat) ? { ...base.repeat } : undefined;
    if (repeat) {
      repeat.rrule = repeat.rrule ? String(repeat.rrule) : undefined;
      repeat.anchorISO = normalizeISO(repeat.anchorISO);
    }

    const estimateMin = Number.isFinite(Number(base.estimateMin))
      ? Math.max(0, Math.trunc(Number(base.estimateMin)))
      : undefined;

    return {
      id,
      title: String(base.title || "").trim() || "Untitled task",
      notes: base.notes != null ? String(base.notes) : undefined,
      status,
      priority,
      domain: base.domain != null ? String(base.domain) : undefined,
      category: base.category != null ? String(base.category) : undefined,
      tags,
      assignees,
      createdAt,
      updatedAt,
      startsAt,
      dueAt,
      completedAt,
      snoozedUntil,
      estimateMin,
      repeat,
      dependencies,
      links,
      notify,
      meta: isObject(base.meta) ? { ...base.meta } : undefined,
    };
  }

  /* ------------------------------ Reminder Hooks ----------------------------- */

  function isWithinQuietHours(prefs, whenISO) {
    try {
      const qh = prefs?.quietHours;
      if (!qh?.enabled) return false;
      const at = whenISO ? new Date(whenISO) : new Date();
      const hhmm = (d) =>
        `${String(d.getHours()).padStart(2, "0")}:${String(
          d.getMinutes()
        ).padStart(2, "0")}`;

      const current = hhmm(at);
      const start = String(qh.start || "22:00");
      const end = String(qh.end || "07:00");

      // Handles wrap-over midnight
      if (start < end) return current >= start && current < end;
      return current >= start || current < end;
    } catch {
      return false;
    }
  }

  async function scheduleTaskReminder(task) {
    try {
      if (!task?.notify?.enabled) return;
      const atISO = task.notify.atISO || task.dueAt;
      if (!atISO) return;

      // Respect quiet hours by skipping scheduling in quiet window
      if (isWithinQuietHours(state.prefs, atISO)) return;

      reminders = reminders || (await tryLoadReminderManager());
      if (!reminders?.scheduleReminder) return;

      const title = task.notify.title || task.title || "Task reminder";
      const body =
        task.notify.body ||
        (task.dueAt ? `Due: ${new Date(task.dueAt).toLocaleString()}` : "");

      await reminders.scheduleReminder({
        id: `task:${task.id}`,
        title,
        body,
        atISO,
        data: {
          kind: "task",
          taskId: task.id,
          domain: task.domain,
          category: task.category,
          ...(task.notify.data || {}),
        },
        tag: task.notify.tag || "ssa-task",
      });
    } catch {
      // ignore reminder errors
    }
  }

  async function cancelTaskReminder(taskId) {
    try {
      reminders = reminders || (await tryLoadReminderManager());
      if (!reminders?.cancelReminder) return;
      await reminders.cancelReminder(`task:${taskId}`);
    } catch {
      // ignore
    }
  }

  /* --------------------------------- Actions -------------------------------- */

  async function init() {
    // Load optional services (best-effort)
    if (!eventBus) eventBus = await tryLoadEventBus();
    if (!dexie) dexie = await tryLoadDexieDB();
    // reminders loaded lazily

    // Hydrate: local first, then dexie merge if available
    const local = loadFromLocalStorage();
    if (local) {
      setState(local, { op: "hydrate.local" });
    } else {
      setState(
        {
          hydrated: true,
          lastHydratedAt: nowISO(),
          source: "local",
        },
        { op: "hydrate.empty" }
      );
    }

    if (dexie) {
      const dx = await loadFromDexieIfAvailable();
      if (dx && dx.source === "dexie" && dx.hydrated) {
        // Merge strategy: Dexie is authoritative if local is empty;
        // otherwise we merge by updatedAt newest-wins.
        setState(
          (prev) => {
            const merged = mergeTaskMaps(prev, dx);
            return {
              ...prev,
              ...merged,
              hydrated: true,
              source: local ? "merged" : "dexie",
              lastHydratedAt: nowISO(),
              error: dx.error || prev.error || null,
              dirty: false,
            };
          },
          { op: "hydrate.dexie.merge" }
        );

        // Persist merged snapshot back to local for faster future loads
        saveToLocalStorage(getState());
      }
    }
  }

  function mergeTaskMaps(aState, bState) {
    const a = aState?.tasksById || {};
    const b = bState?.tasksById || {};
    const out = { ...a };

    for (const id of Object.keys(b)) {
      const at = a[id];
      const bt = b[id];
      if (!at) {
        out[id] = bt;
        continue;
      }
      const aU = at.updatedAt ? new Date(at.updatedAt).getTime() : 0;
      const bU = bt.updatedAt ? new Date(bt.updatedAt).getTime() : 0;
      out[id] = bU >= aU ? bt : at;
    }

    const combinedOrder = stableUnique([
      ...(aState.order || []),
      ...(bState.order || []),
    ]);
    const sorted = sortIds(
      { ...aState, tasksById: out, prefs: aState.prefs },
      combinedOrder.length ? combinedOrder : Object.keys(out),
      aState.prefs?.defaultSort
    );

    return { tasksById: out, order: sorted };
  }

  function persistNow() {
    const snapshot = getState();
    saveToLocalStorage({
      ...snapshot,
      dirty: false,
      lastPersistedAt: nowISO(),
    });

    // Fire-and-forget Dexie persistence (no await to keep UI snappy)
    if (dexie) {
      persistToDexie(snapshot).then((ok) => {
        if (ok) {
          setState(
            (prev) => ({
              ...prev,
              dirty: false,
              lastPersistedAt: nowISO(),
            }),
            { op: "persist.dexie" }
          );
        }
      });
    } else {
      setState(
        (prev) => ({
          ...prev,
          dirty: false,
          lastPersistedAt: nowISO(),
        }),
        { op: "persist.local" }
      );
    }
  }

  function setPrefs(partialOrUpdater) {
    setState(
      (prev) => {
        const nextPrefs =
          typeof partialOrUpdater === "function"
            ? partialOrUpdater(prev.prefs)
            : deepMerge(prev.prefs, partialOrUpdater || {});
        return { ...prev, prefs: nextPrefs, dirty: true };
      },
      { op: "prefs.set" }
    );
  }

  function addTask(taskInput) {
    const t = normalizeTask(taskInput);
    setState(
      (prev) => {
        const tasksById = { ...prev.tasksById, [t.id]: t };
        const order = sortIds(
          { ...prev, tasksById },
          stableUnique([t.id, ...prev.order]),
          prev.prefs?.defaultSort
        );
        return { ...prev, tasksById, order, dirty: true };
      },
      { op: "task.add", id: t.id }
    );

    // schedule reminder if requested
    scheduleTaskReminder(t);
    return t.id;
  }

  function addTasks(taskInputs = []) {
    const created = [];
    setState(
      (prev) => {
        const tasksById = { ...prev.tasksById };
        const orderSeed = [...prev.order];
        for (const input of Array.isArray(taskInputs) ? taskInputs : []) {
          const t = normalizeTask(input);
          tasksById[t.id] = t;
          orderSeed.unshift(t.id);
          created.push(t.id);
          // schedule best-effort after setState (we’ll do below)
        }
        const order = sortIds(
          { ...prev, tasksById },
          stableUnique(orderSeed),
          prev.prefs?.defaultSort
        );
        return { ...prev, tasksById, order, dirty: true };
      },
      { op: "task.addMany", count: created.length }
    );

    // schedule reminders
    for (const id of created) scheduleTaskReminder(getState().tasksById[id]);
    return created;
  }

  function updateTask(taskId, fullTask) {
    if (!taskId) return false;
    const id = String(taskId);
    const existing = state.tasksById[id];
    if (!existing) return false;

    const normalized = normalizeTask(
      { ...fullTask, id, createdAt: existing.createdAt },
      { keepTimestamps: true }
    );
    // preserve createdAt, force updatedAt now
    normalized.createdAt = existing.createdAt;
    normalized.updatedAt = nowISO();

    setState(
      (prev) => {
        const tasksById = { ...prev.tasksById, [id]: normalized };
        const order = sortIds(
          { ...prev, tasksById },
          stableUnique(
            prev.order.includes(id) ? prev.order : [id, ...prev.order]
          ),
          prev.prefs?.defaultSort
        );
        return { ...prev, tasksById, order, dirty: true };
      },
      { op: "task.update", id }
    );

    // reschedule reminder based on new data
    cancelTaskReminder(id);
    scheduleTaskReminder(normalized);

    return true;
  }

  function patchTask(taskId, patch) {
    if (!taskId) return false;
    const id = String(taskId);
    const existing = state.tasksById[id];
    if (!existing) return false;

    const merged = deepMerge(existing, patch || {});
    // normalize keeps id, createdAt; updatedAt now
    const normalized = normalizeTask(
      { ...merged, id, createdAt: existing.createdAt, updatedAt: nowISO() },
      { keepTimestamps: true }
    );
    normalized.createdAt = existing.createdAt;
    normalized.updatedAt = nowISO();

    setState(
      (prev) => {
        const tasksById = { ...prev.tasksById, [id]: normalized };
        const order = sortIds(
          { ...prev, tasksById },
          stableUnique(
            prev.order.includes(id) ? prev.order : [id, ...prev.order]
          ),
          prev.prefs?.defaultSort
        );
        return { ...prev, tasksById, order, dirty: true };
      },
      { op: "task.patch", id }
    );

    // reminder updates
    cancelTaskReminder(id);
    scheduleTaskReminder(normalized);

    return true;
  }

  function setStatus(taskId, status) {
    const allowed = ["todo", "doing", "done", "blocked", "snoozed"];
    const next = allowed.includes(status) ? status : "todo";
    const existing = state.tasksById[String(taskId)];
    if (!existing) return false;

    const patch = {
      status: next,
      completedAt: next === "done" ? nowISO() : undefined,
      snoozedUntil: next === "snoozed" ? existing.snoozedUntil : undefined,
    };

    // If done, cancel reminders
    if (next === "done") cancelTaskReminder(existing.id);

    return patchTask(existing.id, patch);
  }

  function toggleDone(taskId) {
    const t = state.tasksById[String(taskId)];
    if (!t) return false;
    return setStatus(t.id, t.status === "done" ? "todo" : "done");
  }

  function completeTask(taskId) {
    return setStatus(taskId, "done");
  }

  function reopenTask(taskId) {
    return setStatus(taskId, "todo");
  }

  function snoozeTask(taskId, untilISO) {
    const t = state.tasksById[String(taskId)];
    if (!t) return false;
    const snoozedUntil = normalizeISO(untilISO);
    const ok = patchTask(t.id, {
      status: "snoozed",
      snoozedUntil,
    });
    if (ok) {
      cancelTaskReminder(t.id);
      // If snooze has an explicit remind time, schedule it
      const updated = getState().tasksById[t.id];
      scheduleTaskReminder({
        ...updated,
        notify: {
          ...(updated.notify || {}),
          enabled: true,
          atISO: snoozedUntil || updated.dueAt,
          title: (updated.notify && updated.notify.title) || updated.title,
          body:
            (updated.notify && updated.notify.body) || "Snoozed task reminder",
          tag: (updated.notify && updated.notify.tag) || "ssa-task",
        },
      });
    }
    return ok;
  }

  async function deleteTask(taskId) {
    if (!taskId) return false;
    const id = String(taskId);
    const existing = state.tasksById[id];
    if (!existing) return false;

    setState(
      (prev) => {
        const tasksById = { ...prev.tasksById };
        delete tasksById[id];
        const order = prev.order.filter((x) => x !== id);
        return { ...prev, tasksById, order, dirty: true };
      },
      { op: "task.delete", id }
    );

    cancelTaskReminder(id);

    // Best-effort remove from Dexie
    if (dexie) {
      try {
        if (typeof dexie.tasks.delete === "function") {
          await dexie.tasks.delete(id);
        }
      } catch {
        // ignore
      }
    }

    return true;
  }

  function clearCompleted() {
    const idsToRemove = [];
    for (const id of state.order) {
      const t = state.tasksById[id];
      if (t && t.status === "done") idsToRemove.push(id);
    }
    if (!idsToRemove.length) return 0;

    setState(
      (prev) => {
        const tasksById = { ...prev.tasksById };
        for (const id of idsToRemove) delete tasksById[id];
        const order = prev.order.filter((id) => !idsToRemove.includes(id));
        return { ...prev, tasksById, order, dirty: true };
      },
      { op: "task.clearCompleted", count: idsToRemove.length }
    );

    for (const id of idsToRemove) cancelTaskReminder(id);
    return idsToRemove.length;
  }

  function bulkPatch(taskIds, patch) {
    const ids = stableUnique(taskIds);
    if (!ids.length) return 0;

    setState(
      (prev) => {
        const tasksById = { ...prev.tasksById };
        let changed = 0;
        for (const id of ids) {
          const existing = tasksById[id];
          if (!existing) continue;
          const merged = deepMerge(existing, patch || {});
          const normalized = normalizeTask(
            {
              ...merged,
              id,
              createdAt: existing.createdAt,
              updatedAt: nowISO(),
            },
            { keepTimestamps: true }
          );
          normalized.createdAt = existing.createdAt;
          normalized.updatedAt = nowISO();
          tasksById[id] = normalized;
          changed++;
        }
        const order = sortIds(
          { ...prev, tasksById },
          prev.order,
          prev.prefs?.defaultSort
        );
        return {
          ...prev,
          tasksById,
          order,
          dirty: changed ? true : prev.dirty,
        };
      },
      { op: "task.bulkPatch", count: ids.length }
    );

    return ids.length;
  }

  function importTasks(payload, { mode = "merge" } = {}) {
    // payload can be array of tasks OR { tasks: [...] }
    const list = Array.isArray(payload) ? payload : payload?.tasks;
    if (!Array.isArray(list)) return { imported: 0, mode };

    const normalized = list.map((t) =>
      normalizeTask(t, { keepTimestamps: true })
    );
    setState(
      (prev) => {
        const tasksById = mode === "replace" ? {} : { ...prev.tasksById };
        const orderSeed = mode === "replace" ? [] : [...prev.order];

        for (const t of normalized) {
          const existing = tasksById[t.id];
          if (!existing) {
            tasksById[t.id] = t;
            orderSeed.push(t.id);
            continue;
          }
          // merge by updatedAt newest-wins
          const aU = existing.updatedAt
            ? new Date(existing.updatedAt).getTime()
            : 0;
          const bU = t.updatedAt ? new Date(t.updatedAt).getTime() : 0;
          tasksById[t.id] = bU >= aU ? t : existing;
          orderSeed.push(t.id);
        }

        const order = sortIds(
          { ...prev, tasksById },
          stableUnique(orderSeed.length ? orderSeed : Object.keys(tasksById)),
          prev.prefs?.defaultSort
        );

        return { ...prev, tasksById, order, dirty: true };
      },
      { op: "task.import", count: normalized.length, mode }
    );

    // schedule reminders for imported tasks that request it
    for (const t of normalized) scheduleTaskReminder(t);

    return { imported: normalized.length, mode };
  }

  function exportTasks({ includeCompleted = true } = {}) {
    const all = state.order
      .map((id) => state.tasksById[id])
      .filter(Boolean)
      .filter((t) => (includeCompleted ? true : t.status !== "done"));

    return {
      version: SCHEMA_VERSION,
      exportedAt: nowISO(),
      tasks: all,
      prefs: state.prefs,
    };
  }

  /* -------------------------------- Selectors -------------------------------- */

  function list({ filter, sort, includeCompleted } = {}) {
    const includeDone =
      typeof includeCompleted === "boolean"
        ? includeCompleted
        : !state.prefs?.hideCompleted;

    let ids = state.order.slice();

    if (!includeDone) {
      ids = ids.filter((id) => state.tasksById[id]?.status !== "done");
    }

    if (typeof filter === "function") {
      ids = ids.filter((id) => {
        const t = state.tasksById[id];
        return t ? !!filter(t) : false;
      });
    }

    const sorted = sortIds(state, ids, sort || state.prefs?.defaultSort);
    return sorted.map((id) => state.tasksById[id]).filter(Boolean);
  }

  function get(taskId) {
    return state.tasksById[String(taskId)] || null;
  }

  function counts() {
    let total = 0,
      todo = 0,
      doing = 0,
      done = 0,
      blocked = 0,
      snoozed = 0,
      dueSoon = 0,
      overdue = 0;

    const now = Date.now();
    const soonMs = 24 * 60 * 60 * 1000; // 24h

    for (const id of state.order) {
      const t = state.tasksById[id];
      if (!t) continue;
      total++;
      if (t.status === "todo") todo++;
      else if (t.status === "doing") doing++;
      else if (t.status === "done") done++;
      else if (t.status === "blocked") blocked++;
      else if (t.status === "snoozed") snoozed++;

      if (t.status !== "done" && t.dueAt) {
        const due = new Date(t.dueAt).getTime();
        if (Number.isFinite(due)) {
          if (due < now) overdue++;
          else if (due - now <= soonMs) dueSoon++;
        }
      }
    }

    return { total, todo, doing, done, blocked, snoozed, dueSoon, overdue };
  }

  function byDomain(domain) {
    const d = String(domain || "");
    return list({ filter: (t) => String(t.domain || "") === d });
  }

  function forToday() {
    // "today" = due today (local time) OR explicitly tagged "today"
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);

    const startMs = start.getTime();
    const endMs = end.getTime();

    return list({
      filter: (t) => {
        if (t.status === "done") return false;
        if (Array.isArray(t.tags) && t.tags.includes("today")) return true;
        if (!t.dueAt) return false;
        const due = new Date(t.dueAt).getTime();
        return Number.isFinite(due) && due >= startMs && due < endMs;
      },
      sort: "dueAsc",
      includeCompleted: false,
    });
  }

  function overdue() {
    const now = Date.now();
    return list({
      filter: (t) => {
        if (t.status === "done") return false;
        if (!t.dueAt) return false;
        const due = new Date(t.dueAt).getTime();
        return Number.isFinite(due) && due < now;
      },
      sort: "dueAsc",
      includeCompleted: false,
    });
  }

  /* ----------------------------- Public API ---------------------------------- */

  return {
    // core
    getState,
    getSnapshot,
    subscribe,

    // lifecycle
    init,

    // persistence
    persistNow,

    // prefs
    setPrefs,

    // actions
    addTask,
    addTasks,
    updateTask,
    patchTask,
    setStatus,
    toggleDone,
    completeTask,
    reopenTask,
    snoozeTask,
    deleteTask,
    clearCompleted,
    bulkPatch,

    // import/export
    importTasks,
    exportTasks,

    // selectors
    list,
    get,
    counts,
    byDomain,
    forToday,
    overdue,
  };
}

/* -------------------------------- Singleton --------------------------------- */

const TaskStore = createStore();

// Auto-init in browser (safe: no crash on SSR)
if (typeof window !== "undefined") {
  // Defer to next tick so app bootstrap can register eventBus/db first if needed
  Promise.resolve()
    .then(() => TaskStore.init())
    .catch(() => {
      // ignore init errors
    });
}

export default TaskStore;
