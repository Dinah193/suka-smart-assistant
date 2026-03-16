// src/store/MultiTimerStore.js
/**
 * MultiTimerStore (SSA)
 * ---------------------------------------------------------------------------
 * IMPORTANT COMPATIBILITY PATCH (no behavior changes intended)
 * ---------------------------------------------------------------------------
 * Some components (e.g., PrepTaskOptimizer.jsx) import:
 *   import { useTimerStore } from "@/store/MultiTimerStore";
 *
 * But this file exports a default object-based store (not Zustand) and did not
 * provide a named export `useTimerStore`.
 *
 * To keep your existing store intact AND fix the build error, we add a small,
 * browser-safe named export `useTimerStore` that behaves like a lightweight
 * React hook wrapper around MultiTimerStore's subscribe/getSnapshot.
 *
 * - It does NOT convert your store to Zustand.
 * - It does NOT change your existing default export.
 * - It provides a selector-friendly hook: useTimerStore(selector?)
 */

import { isPlainObject, isArr, isStr, isNum, deepMerge } from "@/utils/obj";
import { nowISO } from "@/utils/dates";
import { useSyncExternalStore } from "react";

/* -------------------------------- Constants -------------------------------- */

const SOURCE = "store.MultiTimerStore";

const VERSION = 1;
const STORAGE_KEY = "ssa.multitimer.store.v1";

const DEFAULTS = Object.freeze({
  enabled: true,
  tickMs: 250, // tick resolution (drift-corrected)
  maxTimers: 200,
  persist: {
    enabled: true,
    storageKey: STORAGE_KEY,
  },
  alerts: {
    enabled: true,
    defaultMethod: "toast", // "toast"|"sound"|"notification"|"none"
    suppressInQuietHours: true,
  },
  quietHours: {
    enabled: false,
    // If enabled, alerts can be suppressed between these times
    // (local time, "HH:MM" 24h)
    start: "22:00",
    end: "07:00",
  },
  sabbath: {
    enabled: false,
    // If enabled, suppress alerts between these local weekday/time ranges
    // By default: Friday 18:00 -> Saturday 20:00 (adjust in app)
    // weekday: 0=Sun..6=Sat
    start: { weekday: 5, time: "18:00" },
    end: { weekday: 6, time: "20:00" },
  },
  integrations: {
    eventBus: true, // try import "@/services/events/eventBus"
    reminderManager: true, // try import "@/services/notifications/ReminderManager"
  },
});

/* --------------------------------- State ----------------------------------- */

const state = {
  config: deepClone(DEFAULTS),
  hydrated: false,
  timers: new Map(), // id -> timer
  order: [], // stable ordering (ids)
  lastError: null,
  tickHandle: null,
  ticking: false,
  // integrations (lazy)
  eventBus: null,
  reminder: null,
  // subscribers
  subs: new Set(),
};

/* ------------------------------ Public Export ------------------------------ */

const MultiTimerStore = {
  SOURCE,
  VERSION,
  STORAGE_KEY,

  configure,
  getConfig,
  hydrate,
  isHydrated,
  getLastError,

  // subscribe/useSyncExternalStore-friendly
  subscribe,
  getSnapshot,

  // selectors
  list,
  get,
  findBySession,
  findRunning,

  // actions
  createTimer,
  upsertTimer,
  updateTimer,
  removeTimer,
  removeAll,
  start,
  pause,
  resume,
  cancel,
  reset,
  addTime,
  setRemaining,
  setDuration,

  // bulk helpers
  startAll,
  pauseAll,
  cancelAll,

  // tick control
  ensureTicking,
  stopTicking,

  // formatting helpers
  formatMs,
  summarize,

  // debug
  __debugDump,
};

export default MultiTimerStore;

/* -------------------------------------------------------------------------- */
/* Named export: useTimerStore (compat for PrepTaskOptimizer.jsx)              */
/* -------------------------------------------------------------------------- */
/**
 * useTimerStore(selector?)
 * - React hook wrapper over MultiTimerStore.subscribe/getSnapshot
 * - selector receives the snapshot object:
 *    { version, hydrated, timers: [...] }
 * - If no selector provided, returns the full snapshot.
 */
export function useTimerStore(selector) {
  const getSnap = () => MultiTimerStore.getSnapshot();
  const subscribeSnap = (cb) => MultiTimerStore.subscribe(cb);

  const snap = useSyncExternalStore(subscribeSnap, getSnap, getSnap);

  if (typeof selector === "function") {
    try {
      return selector(snap);
    } catch {
      return snap;
    }
  }
  return snap;
}

/* -------------------------------- Config ----------------------------------- */

function configure(partial = {}) {
  if (!isPlainObject(partial)) return getConfig();
  state.config = deepMerge(deepClone(state.config), partial);
  persistSoon();
  return getConfig();
}

function getConfig() {
  return deepClone(state.config);
}

function isHydrated() {
  return !!state.hydrated;
}

function getLastError() {
  return state.lastError;
}

/* ------------------------------ Subscription ------------------------------- */

function subscribe(fn) {
  if (typeof fn !== "function") return () => {};
  state.subs.add(fn);
  // push initial
  try {
    fn({ type: "init" });
  } catch {
    // ignore
  }
  return () => state.subs.delete(fn);
}

function emit(evt = { type: "changed" }) {
  for (const fn of state.subs) {
    try {
      fn(evt);
    } catch {
      // ignore
    }
  }
}

function getSnapshot() {
  return {
    version: VERSION,
    hydrated: state.hydrated,
    timers: state.order.map((id) => state.timers.get(id)).filter(Boolean),
  };
}

/* -------------------------------- Hydration -------------------------------- */

function hydrate() {
  if (state.hydrated) return true;
  state.lastError = null;

  // best effort integrations
  void ensureIntegrations();

  if (!state.config.persist?.enabled) {
    state.hydrated = true;
    emit({ type: "hydrated", source: "memory" });
    return true;
  }

  try {
    const raw = localStorage.getItem(
      state.config.persist.storageKey || STORAGE_KEY
    );
    if (raw) {
      const parsed = JSON.parse(raw);
      applyHydrated(parsed);
    }
    state.hydrated = true;
    emit({ type: "hydrated", source: "localStorage" });
    ensureTicking();
    return true;
  } catch (e) {
    state.lastError = {
      code: "hydrate_failed",
      message: e?.message || "hydrate failed",
    };
    // proceed with empty
    state.hydrated = true;
    emit({ type: "hydrated", source: "empty" });
    ensureTicking();
    return false;
  }
}

function applyHydrated(parsed) {
  if (!isPlainObject(parsed)) return;
  const timers = isArr(parsed.timers) ? parsed.timers : [];
  state.timers.clear();
  state.order = [];

  for (const t of timers) {
    const norm = normalizeTimer(t, { mode: "read" });
    if (!norm?.id) continue;
    state.timers.set(norm.id, norm);
    state.order.push(norm.id);
  }

  // ensure uniqueness order
  state.order = uniq(state.order);

  // fix any inconsistent fields
  for (const id of state.order) {
    const t = state.timers.get(id);
    if (!t) continue;
    state.timers.set(id, reconcileTimer(t));
  }
}

/* -------------------------------- Persistence ------------------------------ */

let persistTimer = null;

function persistSoon() {
  if (!state.config.persist?.enabled) return;
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    persistNow();
  }, 250);
}

function persistNow() {
  if (!state.config.persist?.enabled) return false;
  try {
    const payload = {
      version: VERSION,
      savedAtISO: nowISO ? nowISO() : new Date().toISOString(),
      timers: state.order.map((id) => state.timers.get(id)).filter(Boolean),
    };
    localStorage.setItem(
      state.config.persist.storageKey || STORAGE_KEY,
      JSON.stringify(payload)
    );
    return true;
  } catch (e) {
    state.lastError = {
      code: "persist_failed",
      message: e?.message || "persist failed",
    };
    return false;
  }
}

/* ------------------------------- Integrations ------------------------------ */

async function ensureIntegrations() {
  // eventBus
  if (state.config.integrations?.eventBus && !state.eventBus) {
    try {
      const mod = await import(/* @vite-ignore */ "@/services/events/eventBus");
      state.eventBus = mod?.eventBus || mod?.default || mod;
    } catch {
      state.eventBus = null;
    }
  }
  // ReminderManager
  if (state.config.integrations?.reminderManager && !state.reminder) {
    try {
      const mod = await import(
        /* @vite-ignore */ "@/services/notifications/ReminderManager"
      );
      state.reminder = mod?.default || mod?.ReminderManager || mod;
    } catch {
      state.reminder = null;
    }
  }
}

function emitBus(type, payload) {
  const bus = state.eventBus;
  if (!bus) return;
  try {
    if (typeof bus.emit === "function") bus.emit(type, payload);
    else if (typeof bus.publish === "function") bus.publish(type, payload);
  } catch {
    // ignore
  }
}

/* -------------------------------- Selectors -------------------------------- */

function list(filters = {}) {
  hydrateIfNeeded();

  const f = normalizeListFilters(filters);

  let arr = state.order.map((id) => state.timers.get(id)).filter(Boolean);

  if (f.sessionId)
    arr = arr.filter((t) => (t.sessionId || null) === f.sessionId);
  if (f.domain) arr = arr.filter((t) => (t.domain || "") === f.domain);
  if (f.status) arr = arr.filter((t) => t.status === f.status);
  if (f.kind) arr = arr.filter((t) => t.kind === f.kind);
  if (f.tag) arr = arr.filter((t) => (t.tags || []).includes(f.tag));

  if (f.search) {
    const q = f.search;
    arr = arr.filter((t) =>
      `${t.label || ""} ${(t.tags || []).join(" ")}`.toLowerCase().includes(q)
    );
  }

  arr = sortTimers(arr, f.sort);

  if (f.limit) arr = arr.slice(0, f.limit);
  return arr;
}

function get(id) {
  hydrateIfNeeded();
  const tid = normId(id);
  if (!tid) return null;
  return state.timers.get(tid) || null;
}

function findBySession(sessionId) {
  return list({ sessionId });
}

function findRunning() {
  return list({ status: "running" });
}

/* --------------------------------- Actions --------------------------------- */

function createTimer(input = {}) {
  hydrateIfNeeded();
  const t = normalizeTimer(input, { mode: "create" });
  if (!t.id) t.id = makeTimerId();
  if (state.timers.has(t.id)) t.id = makeTimerId();

  if (state.order.length >= state.config.maxTimers) {
    // drop oldest idle/canceled/done first
    trimToMax();
  }

  state.timers.set(t.id, reconcileTimer(t));
  state.order.push(t.id);
  state.order = uniq(state.order);

  persistSoon();
  emit({ type: "timer.created", id: t.id });
  emitBus("timer.created", { id: t.id, timer: get(t.id) });
  ensureTicking();
  return get(t.id);
}

function upsertTimer(input = {}) {
  hydrateIfNeeded();
  const t = normalizeTimer(input, { mode: "upsert" });
  if (!t.id) return createTimer(t);

  const existing = state.timers.get(t.id);
  const merged = existing ? deepMerge(deepClone(existing), t) : t;

  state.timers.set(t.id, reconcileTimer(merged));
  if (!state.order.includes(t.id)) state.order.push(t.id);

  persistSoon();
  emit({ type: "timer.upserted", id: t.id });
  emitBus("timer.upserted", { id: t.id, timer: get(t.id) });
  ensureTicking();
  return get(t.id);
}

function updateTimer(id, patch = {}) {
  hydrateIfNeeded();
  const tid = normId(id);
  if (!tid) return null;

  const existing = state.timers.get(tid);
  if (!existing) return null;

  const merged = deepMerge(
    deepClone(existing),
    isPlainObject(patch) ? patch : {}
  );
  const t = reconcileTimer(normalizeTimer(merged, { mode: "update" }));

  state.timers.set(tid, t);

  persistSoon();
  emit({ type: "timer.updated", id: tid });
  emitBus("timer.updated", { id: tid, timer: t });
  ensureTicking();
  return t;
}

function removeTimer(id) {
  hydrateIfNeeded();
  const tid = normId(id);
  if (!tid) return false;
  const existed = state.timers.delete(tid);
  state.order = state.order.filter((x) => x !== tid);

  persistSoon();
  emit({ type: "timer.removed", id: tid });
  emitBus("timer.removed", { id: tid });
  return existed;
}

function removeAll() {
  hydrateIfNeeded();
  state.timers.clear();
  state.order = [];
  persistSoon();
  emit({ type: "timers.cleared" });
  emitBus("timers.cleared", {});
  stopTicking();
  return true;
}

/* --------------------------- Lifecycle: start/pause -------------------------- */

function start(id) {
  hydrateIfNeeded();
  const t = get(id);
  if (!t) return null;

  // restart from idle/paused; if done/canceled, reset first
  let next = t;
  if (t.status === "done" || t.status === "canceled") next = reset(id);

  const now = Date.now();

  if (next.kind === "countdown") {
    const remaining = safeMs(next.remainingMs ?? next.durationMs ?? 0);
    const dueAt = now + remaining;

    next = updateTimer(next.id, {
      status: "running",
      startedAt: now,
      lastTickAt: now,
      dueAt,
      completedAt: null,
      _fired: false,
    });
  } else {
    // stopwatch
    next = updateTimer(next.id, {
      status: "running",
      startedAt: now,
      lastTickAt: now,
      completedAt: null,
      _fired: false,
    });
  }

  scheduleReminderIfNeeded(next);
  ensureTicking();
  emitBus("timer.started", { id: next.id, timer: next });
  return next;
}

function pause(id) {
  hydrateIfNeeded();
  const t = get(id);
  if (!t || t.status !== "running") return t;

  const now = Date.now();
  const updated = tickOne(t, now); // capture latest elapsed/remaining

  const next = updateTimer(updated.id, {
    status: "paused",
    startedAt: null,
    lastTickAt: now,
    dueAt: updated.kind === "countdown" ? updated.dueAt : updated.dueAt,
  });

  cancelReminderIfScheduled(next);
  emitBus("timer.paused", { id: next.id, timer: next });
  return next;
}

function resume(id) {
  hydrateIfNeeded();
  const t = get(id);
  if (!t || t.status !== "paused") return t;

  const now = Date.now();
  let next = t;

  if (t.kind === "countdown") {
    const remaining = safeMs(t.remainingMs ?? 0);
    next = updateTimer(t.id, {
      status: "running",
      startedAt: now,
      lastTickAt: now,
      dueAt: now + remaining,
      _fired: false,
    });
  } else {
    next = updateTimer(t.id, {
      status: "running",
      startedAt: now,
      lastTickAt: now,
      _fired: false,
    });
  }

  scheduleReminderIfNeeded(next);
  ensureTicking();
  emitBus("timer.resumed", { id: next.id, timer: next });
  return next;
}

function cancel(id) {
  hydrateIfNeeded();
  const t = get(id);
  if (!t) return null;

  const now = Date.now();
  const updated = updateTimer(t.id, {
    status: "canceled",
    startedAt: null,
    lastTickAt: now,
    dueAt: null,
    completedAt: null,
    _fired: true,
  });

  cancelReminderIfScheduled(updated);
  emitBus("timer.canceled", { id: updated.id, timer: updated });
  return updated;
}

function reset(id) {
  hydrateIfNeeded();
  const t = get(id);
  if (!t) return null;

  const now = Date.now();
  const next = updateTimer(t.id, {
    status: "idle",
    elapsedMs: 0,
    remainingMs: t.kind === "countdown" ? safeMs(t.durationMs ?? 0) : undefined,
    startedAt: null,
    lastTickAt: now,
    dueAt: null,
    completedAt: null,
    _fired: false,
  });

  cancelReminderIfScheduled(next);
  emitBus("timer.reset", { id: next.id, timer: next });
  return next;
}

function addTime(id, deltaMs) {
  hydrateIfNeeded();
  const t = get(id);
  if (!t) return null;

  const d = safeMs(deltaMs);
  if (t.kind !== "countdown") return t;

  // if running, shift dueAt; if paused/idle, adjust remaining/duration
  const now = Date.now();
  if (t.status === "running" && isNum(t.dueAt)) {
    const dueAt = t.dueAt + d;
    return updateTimer(t.id, {
      dueAt,
      remainingMs: Math.max(0, dueAt - now),
      durationMs: safeMs(t.durationMs ?? 0) + d,
    });
  }

  const remaining = safeMs(t.remainingMs ?? t.durationMs ?? 0) + d;
  const duration = safeMs(t.durationMs ?? 0) + d;

  return updateTimer(t.id, {
    remainingMs: Math.max(0, remaining),
    durationMs: Math.max(0, duration),
    updatedAt: now,
  });
}

function setRemaining(id, remainingMs) {
  hydrateIfNeeded();
  const t = get(id);
  if (!t || t.kind !== "countdown") return t;

  const rem = Math.max(0, safeMs(remainingMs));
  const now = Date.now();

  // If running, adjust dueAt to now+rem
  if (t.status === "running") {
    const next = updateTimer(t.id, {
      remainingMs: rem,
      dueAt: now + rem,
      lastTickAt: now,
    });
    scheduleReminderIfNeeded(next);
    return next;
  }

  return updateTimer(t.id, { remainingMs: rem });
}

function setDuration(id, durationMs) {
  hydrateIfNeeded();
  const t = get(id);
  if (!t || t.kind !== "countdown") return t;

  const dur = Math.max(0, safeMs(durationMs));
  const now = Date.now();

  // If idle/paused, remaining follows duration unless user already changed it
  if (t.status !== "running") {
    return updateTimer(t.id, { durationMs: dur, remainingMs: dur });
  }

  // If running, compute remaining and update dueAt accordingly
  const remaining = safeMs(
    t.remainingMs ?? Math.max(0, (t.dueAt || now) - now)
  );
  const ratio =
    t.durationMs || remaining || 1
      ? dur / Math.max(1, t.durationMs || remaining || 1)
      : 1;
  const newRemaining = Math.max(0, Math.floor(remaining * ratio));
  const next = updateTimer(t.id, {
    durationMs: dur,
    remainingMs: newRemaining,
    dueAt: now + newRemaining,
    lastTickAt: now,
  });
  scheduleReminderIfNeeded(next);
  return next;
}

/* -------------------------------- Bulk ------------------------------------- */

function startAll(filters = {}) {
  const arr = list(filters);
  return arr.map((t) => start(t.id));
}

function pauseAll(filters = {}) {
  const arr = list(filters);
  return arr.map((t) => pause(t.id));
}

function cancelAll(filters = {}) {
  const arr = list(filters);
  return arr.map((t) => cancel(t.id));
}

/* -------------------------------- Ticking ---------------------------------- */

function ensureTicking() {
  hydrateIfNeeded();
  if (!state.config.enabled) return false;
  if (state.ticking) return true;

  const hasRunning = state.order.some(
    (id) => state.timers.get(id)?.status === "running"
  );
  if (!hasRunning) return false;

  state.ticking = true;
  if (state.tickHandle) clearInterval(state.tickHandle);

  const interval = Math.max(50, Math.floor(safeMs(state.config.tickMs || 250)));
  state.tickHandle = setInterval(() => tickAll(), interval);
  return true;
}

function stopTicking() {
  state.ticking = false;
  if (state.tickHandle) clearInterval(state.tickHandle);
  state.tickHandle = null;
  return true;
}

function tickAll() {
  if (!state.config.enabled) return stopTicking();
  const now = Date.now();

  let anyRunning = false;
  let changed = false;

  for (const id of state.order) {
    const t = state.timers.get(id);
    if (!t || t.status !== "running") continue;
    anyRunning = true;

    const next = tickOne(t, now);
    if (next !== t) {
      state.timers.set(id, next);
      changed = true;

      if (next.status === "done") {
        onTimerDone(next);
      }
    }
  }

  if (changed) {
    persistSoon();
    emit({ type: "tick" });
  }

  if (!anyRunning) stopTicking();
}

function tickOne(timer, now) {
  const t = timer;
  const last = isNum(t.lastTickAt) ? t.lastTickAt : now;
  const dt = Math.max(0, now - last);

  // drift-correct: use dueAt for countdown, elapsed for stopwatch
  if (t.kind === "countdown") {
    const dueAt = isNum(t.dueAt) ? t.dueAt : now + safeMs(t.remainingMs ?? 0);
    const remaining = Math.max(0, dueAt - now);
    const elapsed = safeMs(t.durationMs ?? 0) - remaining;

    // done?
    if (remaining <= 0) {
      return finalizeDone(t, now, {
        elapsedMs: Math.max(0, safeMs(t.durationMs ?? elapsed)),
        remainingMs: 0,
        dueAt,
      });
    }

    // running
    if (remaining !== t.remainingMs || dt > 0) {
      return reconcileTimer({
        ...t,
        elapsedMs: Math.max(0, elapsed),
        remainingMs: remaining,
        lastTickAt: now,
        updatedAt: now,
        dueAt,
      });
    }

    return t;
  }

  // stopwatch
  const elapsed = safeMs(t.elapsedMs) + dt;
  return reconcileTimer({
    ...t,
    elapsedMs: elapsed,
    lastTickAt: now,
    updatedAt: now,
  });
}

function finalizeDone(timer, now, patch) {
  const next = reconcileTimer({
    ...timer,
    ...patch,
    status: "done",
    startedAt: null,
    lastTickAt: now,
    completedAt: now,
    updatedAt: now,
  });
  return next;
}

function onTimerDone(timer) {
  // one-shot guard
  if (timer._fired) return;

  const updated = updateTimer(timer.id, { _fired: true });
  void updated;

  cancelReminderIfScheduled(timer);

  // emit bus event
  emitBus("timer.done", { id: timer.id, timer });

  // best-effort alert
  if (state.config.alerts.enabled && timer.alert?.enabled !== false) {
    if (!shouldSuppressAlerts(timer)) {
      fireAlert(timer);
    } else {
      emitBus("timer.alert.suppressed", { id: timer.id, timer });
    }
  }

  emit({ type: "timer.done", id: timer.id });
}

function shouldSuppressAlerts(timer) {
  const cfg = state.config;
  const suppress =
    timer.alert?.suppressInQuietHours ?? cfg.alerts.suppressInQuietHours;
  if (!suppress) return false;

  // quiet hours
  if (cfg.quietHours?.enabled && inQuietHours(cfg.quietHours)) return true;

  // sabbath
  if (cfg.sabbath?.enabled && inSabbathWindow(cfg.sabbath)) return true;

  return false;
}

/* -------------------------------- Alerts ----------------------------------- */

function fireAlert(timer) {
  const method =
    timer.alert?.method || state.config.alerts.defaultMethod || "toast";

  if (method === "notification") {
    void notifyBrowser(timer);
    return;
  }
  if (method === "sound") {
    // caller can implement sound playback elsewhere; here we just emit an event
    emitBus("timer.sound", {
      id: timer.id,
      soundId: timer.alert?.soundId || "default",
      timer,
    });
    return;
  }
  if (method === "toast") {
    emitBus("timer.toast", {
      id: timer.id,
      message: `${timer.label || "Timer"} done`,
      timer,
    });
    return;
  }

  // none
}

async function notifyBrowser(timer) {
  // Prefer ReminderManager if present (it can show SW notification)
  await ensureIntegrations();
  const rm = state.reminder;

  const title = timer.alert?.notification?.title || "Timer done";
  const body =
    timer.alert?.notification?.body ||
    timer.label ||
    "Your timer has finished.";
  const tag = timer.alert?.notification?.tag || `ssa_timer_${timer.id}`;

  if (rm && typeof rm.requestPermission === "function") {
    try {
      await rm.requestPermission();
    } catch {
      // ignore
    }
  }

  if (rm && typeof rm.scheduleReminder === "function") {
    try {
      // send immediately (atISO now)
      const atISO = nowISO ? nowISO() : new Date().toISOString();
      await rm.scheduleReminder({
        id: `timer_done_${timer.id}`,
        title,
        body,
        atISO,
        data: { timerId: timer.id },
        tag,
      });
      return;
    } catch {
      // fallback below
    }
  }

  // direct Notifications API fallback
  try {
    if (!("Notification" in window)) return;
    if (Notification.permission !== "granted") {
      const perm = await Notification.requestPermission();
      if (perm !== "granted") return;
    }
    // eslint-disable-next-line no-new
    new Notification(title, { body, tag });
  } catch {
    // ignore
  }
}

/* ---------------------- Reminder scheduling (optional) ---------------------- */

function scheduleReminderIfNeeded(timer) {
  // Only schedule for countdown timers with notifications enabled
  if (!timer || timer.kind !== "countdown") return;
  const method = timer.alert?.method || state.config.alerts.defaultMethod;
  if (method !== "notification") return;
  if (timer.status !== "running") return;
  if (!isNum(timer.dueAt)) return;

  void (async () => {
    await ensureIntegrations();
    const rm = state.reminder;
    if (!rm || typeof rm.scheduleReminder !== "function") return;

    const title = timer.alert?.notification?.title || "Timer done";
    const body =
      timer.alert?.notification?.body ||
      timer.label ||
      "Your timer has finished.";
    const tag = timer.alert?.notification?.tag || `ssa_timer_${timer.id}`;
    const atISO = new Date(timer.dueAt).toISOString();

    try {
      await rm.scheduleReminder({
        id: `timer_${timer.id}`,
        title,
        body,
        atISO,
        data: {
          timerId: timer.id,
          kind: timer.kind,
          sessionId: timer.sessionId || null,
        },
        tag,
      });
    } catch {
      // ignore
    }
  })();
}

function cancelReminderIfScheduled(timer) {
  if (!timer) return;
  void (async () => {
    await ensureIntegrations();
    const rm = state.reminder;
    if (!rm || typeof rm.cancelReminder !== "function") return;
    try {
      await rm.cancelReminder(`timer_${timer.id}`);
    } catch {
      // ignore
    }
  })();
}

/* ---------------------------- Normalization -------------------------------- */

function normalizeTimer(input, { mode = "read" } = {}) {
  const now = Date.now();

  let t = null;
  if (isPlainObject(input)) t = { ...input };
  else t = {};

  const id = normId(t.id || t.key || "");
  const label = String(t.label || t.name || "Timer")
    .trim()
    .slice(0, 120);

  const kind =
    t.kind === "stopwatch" || t.kind === "countdown" ? t.kind : inferKind(t);
  let status = normalizeStatus(t.status, mode);

  const createdAt = isNum(t.createdAt) ? Number(t.createdAt) : now;
  const updatedAt = now;

  const durationMs =
    kind === "countdown"
      ? safeMs(
          t.durationMs ??
            t.duration ??
            (isNum(t.minutes) ? Number(t.minutes) * 60_000 : null) ??
            0
        )
      : undefined;

  const elapsedMs = safeMs(t.elapsedMs ?? t.elapsed ?? 0);

  const remainingMs =
    kind === "countdown"
      ? safeMs(
          t.remainingMs ??
            t.remaining ??
            (isNum(t.remainingMin) ? Number(t.remainingMin) * 60_000 : null) ??
            durationMs ??
            0
        )
      : undefined;

  const startedAt = isNum(t.startedAt) ? Number(t.startedAt) : null;
  const lastTickAt = isNum(t.lastTickAt) ? Number(t.lastTickAt) : null;
  const dueAt = kind === "countdown" && isNum(t.dueAt) ? Number(t.dueAt) : null;

  const completedAt = isNum(t.completedAt) ? Number(t.completedAt) : null;

  const domain = isStr(t.domain) ? t.domain : undefined;
  const sessionId = t.sessionId != null ? normId(t.sessionId) || null : null;

  const tags = normalizeTags(t.tags);
  const data = isPlainObject(t.data)
    ? t.data
    : isPlainObject(t.meta)
    ? t.meta
    : {};

  const alert = normalizeAlert(t.alert);

  const _fired = !!t._fired;

  // auto status fixes
  if (mode === "create" && !t.status) status = "idle";

  return reconcileTimer({
    ...t,
    id,
    label,
    kind,
    status,
    durationMs,
    elapsedMs,
    remainingMs,
    startedAt,
    lastTickAt,
    dueAt,
    createdAt,
    updatedAt,
    completedAt,
    domain,
    sessionId,
    tags,
    data,
    alert,
    _fired,
  });
}

function reconcileTimer(t) {
  const now = Date.now();
  const out = { ...t };

  // Ensure id exists for store use
  if (!out.id) return out;

  // Status coherence
  if (!out.status) out.status = "idle";

  // Countdown coherence
  if (out.kind === "countdown") {
    out.durationMs = safeMs(out.durationMs ?? 0);

    // remaining defaults to duration - elapsed
    if (!isNum(out.remainingMs)) {
      out.remainingMs = Math.max(
        0,
        out.durationMs - safeMs(out.elapsedMs ?? 0)
      );
    }

    // If running but no dueAt, derive from remaining
    if (out.status === "running" && !isNum(out.dueAt)) {
      out.dueAt = now + safeMs(out.remainingMs ?? 0);
    }

    // If done, remaining must be 0
    if (out.status === "done") {
      out.remainingMs = 0;
      out.dueAt = out.dueAt ?? out.completedAt ?? null;
      out._fired = out._fired ?? true;
    }
  } else {
    // stopwatch
    out.durationMs = undefined;
    out.remainingMs = undefined;
    out.dueAt = null;
  }

  // If canceled, no dueAt
  if (out.status === "canceled") {
    out.dueAt = null;
    out.startedAt = null;
    out._fired = true;
  }

  // Ensure timestamps exist
  out.createdAt = isNum(out.createdAt) ? Number(out.createdAt) : now;
  out.updatedAt = isNum(out.updatedAt) ? Number(out.updatedAt) : now;

  return out;
}

function inferKind(t) {
  // if duration/remaining present, countdown
  if (
    isNum(t.durationMs) ||
    isNum(t.remainingMs) ||
    isNum(t.duration) ||
    isNum(t.minutes)
  )
    return "countdown";
  return "stopwatch";
}

function normalizeStatus(status, mode) {
  const s = String(status || "")
    .trim()
    .toLowerCase();
  const allowed = new Set(["idle", "running", "paused", "done", "canceled"]);
  if (allowed.has(s)) return s;
  if (mode === "read") return "idle";
  return "idle";
}

function normalizeAlert(alert) {
  const cfg = state.config;
  if (!isPlainObject(alert)) {
    return {
      enabled: true,
      method: cfg.alerts.defaultMethod,
      suppressInQuietHours: cfg.alerts.suppressInQuietHours,
    };
  }

  const method = ["none", "toast", "sound", "notification"].includes(
    String(alert.method || "")
  )
    ? String(alert.method)
    : cfg.alerts.defaultMethod;

  return {
    enabled: alert.enabled !== false,
    method,
    soundId: isStr(alert.soundId) ? alert.soundId : undefined,
    notification: isPlainObject(alert.notification)
      ? alert.notification
      : undefined,
    suppressInQuietHours:
      alert.suppressInQuietHours !== undefined
        ? !!alert.suppressInQuietHours
        : cfg.alerts.suppressInQuietHours,
  };
}

/* -------------------------------- Utilities -------------------------------- */

function hydrateIfNeeded() {
  if (!state.hydrated) hydrate();
}

function trimToMax() {
  const max = Math.max(1, Math.floor(state.config.maxTimers || 200));
  if (state.order.length < max) return;

  // remove oldest timers that are not running first
  const candidates = state.order
    .map((id) => state.timers.get(id))
    .filter(Boolean)
    .filter((t) => t.status !== "running")
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));

  while (state.order.length >= max && candidates.length) {
    const t = candidates.shift();
    if (t) removeTimer(t.id);
  }

  // If still too many, remove oldest regardless (never remove running first unless necessary)
  while (state.order.length >= max) {
    const id = state.order[0];
    const t = state.timers.get(id);
    if (t && t.status === "running") break;
    removeTimer(id);
  }
}

function normalizeListFilters(filters) {
  const f = isPlainObject(filters) ? filters : {};
  return {
    sessionId: f.sessionId ? normId(f.sessionId) : null,
    domain: f.domain ? String(f.domain) : null,
    status: f.status ? String(f.status) : null,
    kind: f.kind ? String(f.kind) : null,
    tag: f.tag ? normKey(f.tag) : null,
    search: isStr(f.search) ? f.search.trim().toLowerCase() : "",
    sort: f.sort || "created_desc", // created_desc, created_asc, due_asc, due_desc, label_asc
    limit: f.limit != null ? Math.max(0, Math.floor(safeMs(f.limit))) : 0,
  };
}

function sortTimers(arr, sortKey) {
  const key = normKey(sortKey);
  const a = arr.slice();

  const cmp = (x, y) => (x > y ? 1 : x < y ? -1 : 0);

  a.sort((A, B) => {
    const a1 = A || {};
    const b1 = B || {};
    if (key === "created_asc") return cmp(a1.createdAt || 0, b1.createdAt || 0);
    if (key === "created_desc")
      return cmp(b1.createdAt || 0, a1.createdAt || 0);

    if (key === "due_asc")
      return cmp(a1.dueAt || Infinity, b1.dueAt || Infinity);
    if (key === "due_desc")
      return cmp(b1.dueAt || -Infinity, a1.dueAt || -Infinity);

    if (key === "label_asc")
      return cmp(
        (a1.label || "").toLowerCase(),
        (b1.label || "").toLowerCase()
      );

    return cmp(b1.createdAt || 0, a1.createdAt || 0);
  });

  return a;
}

function makeTimerId() {
  return `mt_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function normId(x) {
  const s = String(x || "").trim();
  return s || "";
}

function normKey(x) {
  return String(x || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function safeMs(x) {
  const n = Number(x);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
}

function uniq(arr) {
  const out = [];
  const seen = new Set();
  for (const x of arr) {
    if (!x) continue;
    if (seen.has(x)) continue;
    seen.add(x);
    out.push(x);
  }
  return out;
}

function deepClone(x) {
  if (!isPlainObject(x) && !isArr(x)) return x;
  try {
    return JSON.parse(JSON.stringify(x));
  } catch {
    return isArr(x) ? x.slice() : { ...x };
  }
}

function normalizeTags(tags) {
  if (!isArr(tags)) return [];
  const out = [];
  const seen = new Set();
  for (const t of tags) {
    const k = normKey(t);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(String(t));
  }
  return out;
}

/* ---------------------------- Quiet Hours Logic ----------------------------- */

function inQuietHours(qh) {
  const start = parseHM(qh.start);
  const end = parseHM(qh.end);
  if (!start || !end) return false;

  const now = new Date();
  const minutes = now.getHours() * 60 + now.getMinutes();

  const s = start.h * 60 + start.m;
  const e = end.h * 60 + end.m;

  // wrap window (e.g., 22:00 -> 07:00)
  if (s > e) {
    return minutes >= s || minutes < e;
  }
  return minutes >= s && minutes < e;
}

function inSabbathWindow(sb) {
  const start = sb.start || null;
  const end = sb.end || null;
  if (!start || !end) return false;

  const s = parseHM(start.time);
  const e = parseHM(end.time);
  if (!s || !e) return false;

  const now = new Date();
  const wd = now.getDay(); // 0..6
  const minutes = now.getHours() * 60 + now.getMinutes();

  const sMin = s.h * 60 + s.m;
  const eMin = e.h * 60 + e.m;

  // same-day window
  if (start.weekday === end.weekday) {
    if (wd !== start.weekday) return false;
    return minutes >= sMin && minutes < eMin;
  }

  // cross-day window (typical)
  if (wd === start.weekday) return minutes >= sMin;
  if (wd === end.weekday) return minutes < eMin;

  // in between days
  // handle wrap around week
  if (start.weekday < end.weekday) {
    return wd > start.weekday && wd < end.weekday;
  }
  // wrap (e.g., Sat->Sun)
  return wd > start.weekday || wd < end.weekday;
}

function parseHM(str) {
  const s = String(str || "").trim();
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!m) return null;
  const h = Math.max(0, Math.min(23, Number(m[1])));
  const mm = Math.max(0, Math.min(59, Number(m[2])));
  return { h, m: mm };
}

/* ------------------------------ Formatting --------------------------------- */

function formatMs(ms, opts = {}) {
  const n = Math.max(0, Math.floor(Number(ms || 0)));
  const showMs = !!opts.showMs;

  const totalSec = Math.floor(n / 1000);
  const msPart = n % 1000;
  const sec = totalSec % 60;
  const totalMin = Math.floor(totalSec / 60);
  const min = totalMin % 60;
  const hr = Math.floor(totalMin / 60);

  const pad2 = (x) => String(x).padStart(2, "0");
  const base =
    hr > 0 ? `${hr}:${pad2(min)}:${pad2(sec)}` : `${min}:${pad2(sec)}`;
  return showMs ? `${base}.${String(msPart).padStart(3, "0")}` : base;
}

function summarize(id) {
  const t = get(id);
  if (!t) return null;

  const remaining = t.kind === "countdown" ? safeMs(t.remainingMs ?? 0) : null;

  return {
    id: t.id,
    label: t.label,
    kind: t.kind,
    status: t.status,
    elapsed: formatMs(t.elapsedMs),
    remaining: remaining != null ? formatMs(remaining) : null,
    dueAt: t.dueAt ? new Date(t.dueAt).toISOString() : null,
    sessionId: t.sessionId || null,
    domain: t.domain || null,
    tags: t.tags || [],
  };
}

/* -------------------------------- Debug ------------------------------------ */

function __debugDump() {
  const snap = getSnapshot();
  return {
    source: SOURCE,
    version: VERSION,
    hydrated: state.hydrated,
    timers: snap.timers.length,
    running: snap.timers.filter((t) => t.status === "running").length,
    config: getConfig(),
    lastError: state.lastError,
    integrations: {
      eventBus: !!state.eventBus,
      reminderManager: !!state.reminder,
    },
  };
}
