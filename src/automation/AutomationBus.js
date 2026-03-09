// File: src/automation/AutomationBus.js
/**
 * AutomationBus (SSA)
 * -----------------------------------------------------------------------------
 * Purpose
 *  - Central, browser-safe automation event bus + orchestration helper.
 *  - Provides:
 *      • publish/subscribe (topic + wildcard)
 *      • request/response RPC style calls (ask/handle)
 *      • one-shot listeners
 *      • buffered replay (optional) for late subscribers
 *      • middleware (tap) for logging/metrics
 *      • "quiet hours / sabbath" suppression hooks (emit but mark suppressed)
 *      • safe, defensive runtime that never crashes builds
 *
 * SSA Integration
 *  - Works alongside your existing "@/services/events/eventBus" if present:
 *      • If found, AutomationBus will forward events to it (best-effort).
 *  - Designed for automation runtime flows:
 *      • ingest.uploaded -> artifact.created -> parsed -> method_maps -> blueprint -> session.intent
 *
 * Notes
 *  - Browser-only: no Node imports.
 *  - Avoids dependencies; relies on small local utilities.
 */

import { isPlainObject, isArr, isStr, deepMerge } from "@/utils/obj";
import { nowISO } from "@/utils/dates";

/* -------------------------------- Constants -------------------------------- */

const SOURCE = "automation.AutomationBus";

const DEFAULTS = Object.freeze({
  enabled: true,
  forwardToEventBus: true, // best-effort forward to "@/services/events/eventBus"
  buffer: {
    enabled: true,
    maxEvents: 500, // circular buffer
    replayOnSubscribe: false, // if true, replay buffered events matching pattern
  },
  middleware: {
    enabled: true,
  },
  guards: {
    // If these windows are enabled, we DO NOT prevent publishing.
    // We mark events with meta.suppressed = true for downstream handlers to respect.
    quietHours: {
      enabled: false,
      start: "22:00",
      end: "07:00",
    },
    sabbath: {
      enabled: false,
      start: { weekday: 5, time: "18:00" }, // Fri 18:00
      end: { weekday: 6, time: "20:00" }, // Sat 20:00
    },
  },
  // If a handler throws, keep going.
  errorHandling: {
    swallow: true,
    emitErrorTopic: "automation.error",
  },
  // RPC timeouts
  rpc: {
    defaultTimeoutMs: 10_000,
  },
});

/* --------------------------------- Helpers --------------------------------- */

function clamp(n, a, b) {
  const x = Number(n);
  if (!Number.isFinite(x)) return a;
  return Math.min(b, Math.max(a, x));
}

function normTopic(t) {
  return String(t || "")
    .trim()
    .replace(/\s+/g, " ");
}

function isFn(x) {
  return typeof x === "function";
}

function deepClone(x) {
  if (!isPlainObject(x) && !isArr(x)) return x;
  try {
    return JSON.parse(JSON.stringify(x));
  } catch {
    return isArr(x) ? x.slice() : { ...x };
  }
}

function makeId(prefix = "evt") {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function parseHM(str) {
  const s = String(str || "").trim();
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!m) return null;
  const h = Math.max(0, Math.min(23, Number(m[1])));
  const mm = Math.max(0, Math.min(59, Number(m[2])));
  return { h, m: mm };
}

function inQuietHours(qh) {
  const start = parseHM(qh.start);
  const end = parseHM(qh.end);
  if (!start || !end) return false;

  const now = new Date();
  const minutes = now.getHours() * 60 + now.getMinutes();

  const s = start.h * 60 + start.m;
  const e = end.h * 60 + end.m;

  // wrap (e.g., 22:00 -> 07:00)
  if (s > e) return minutes >= s || minutes < e;
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

  if (start.weekday === end.weekday) {
    if (wd !== start.weekday) return false;
    return minutes >= sMin && minutes < eMin;
  }

  if (wd === start.weekday) return minutes >= sMin;
  if (wd === end.weekday) return minutes < eMin;

  if (start.weekday < end.weekday)
    return wd > start.weekday && wd < end.weekday;
  return wd > start.weekday || wd < end.weekday;
}

/* ----------------------------- Pattern Matching ---------------------------- */
/**
 * Patterns support:
 *  - exact: "session.started"
 *  - wildcard suffix: "session.*"
 *  - wildcard anywhere segments: "ingest.*.done"
 *  - global: "*"
 */
function topicMatches(pattern, topic) {
  const p = normTopic(pattern);
  const t = normTopic(topic);
  if (!p || !t) return false;
  if (p === "*") return true;
  if (p === t) return true;

  // escape regex special then replace * with .*
  const re = new RegExp(
    "^" +
      p
        .split("*")
        .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join(".*") +
      "$"
  );
  return re.test(t);
}

/* ------------------------------ Bus Internals ------------------------------ */

const state = {
  config: deepClone(DEFAULTS),
  listeners: new Map(), // pattern -> Set<fn>
  onceListeners: new Map(), // pattern -> Set<fn>
  middleware: new Set(), // fn(ctx,next)
  buffer: [], // recent events
  eventBus: null, // optional forward target
  rpcHandlers: new Map(), // method -> fn(payload, meta)
};

async function ensureForwardBus() {
  if (!state.config.forwardToEventBus) return;
  if (state.eventBus) return;
  try {
    const mod = await import(/* @vite-ignore */ "@/services/events/eventBus");
    state.eventBus = mod?.eventBus || mod?.default || mod;
  } catch {
    state.eventBus = null;
  }
}

function computeSuppressedMeta() {
  const g = state.config.guards || {};
  const qh = g.quietHours || {};
  const sb = g.sabbath || {};
  const suppressed =
    (qh.enabled && inQuietHours(qh)) || (sb.enabled && inSabbathWindow(sb));
  return suppressed;
}

function bufferPush(evt) {
  if (!state.config.buffer?.enabled) return;
  const max = clamp(state.config.buffer?.maxEvents, 0, 50_000);
  if (max === 0) return;

  state.buffer.push(evt);
  if (state.buffer.length > max) {
    // trim from front
    state.buffer.splice(0, state.buffer.length - max);
  }
}

function getMatchingHandlers(map, topic) {
  const out = [];
  for (const [pattern, set] of map.entries()) {
    if (!set || set.size === 0) continue;
    if (topicMatches(pattern, topic)) {
      for (const fn of set) out.push({ pattern, fn });
    }
  }
  return out;
}

function safeInvoke(fn, args, onError) {
  try {
    return fn(...args);
  } catch (e) {
    onError?.(e);
    return undefined;
  }
}

function emitError(error, originTopic, evt) {
  const cfg = state.config.errorHandling || {};
  const topic = cfg.emitErrorTopic || "automation.error";
  const payload = {
    message: error?.message || String(error),
    stack: error?.stack || null,
    originTopic,
    eventId: evt?.id || null,
  };
  // Avoid recursion if error topic itself crashes
  if (originTopic === topic) return;
  publish(topic, payload, { _internal: true });
}

/* --------------------------------- Public API ------------------------------ */

export function configureAutomationBus(partial = {}) {
  if (!isPlainObject(partial)) return getConfig();
  state.config = deepMerge(deepClone(state.config), partial);
  return getConfig();
}

export function getConfig() {
  return deepClone(state.config);
}

/**
 * Subscribe to a topic pattern.
 * @param {string} pattern e.g. "session.*" or "*"
 * @param {function} fn (payload, meta, evt) => void
 * @param {object} opts { replay?: boolean }
 */
export function on(pattern, fn, opts = {}) {
  const p = normTopic(pattern);
  if (!p || !isFn(fn)) return () => {};

  if (!state.listeners.has(p)) state.listeners.set(p, new Set());
  state.listeners.get(p).add(fn);

  // optional replay
  const replay = !!opts.replay || !!state.config.buffer?.replayOnSubscribe;
  if (replay && state.config.buffer?.enabled && state.buffer.length) {
    const matches = state.buffer.filter((evt) => topicMatches(p, evt.topic));
    for (const evt of matches) {
      safeInvoke(
        fn,
        [deepClone(evt.payload), deepClone(evt.meta), deepClone(evt)],
        (e) => {
          if (state.config.errorHandling?.swallow) emitError(e, evt.topic, evt);
          else throw e;
        }
      );
    }
  }

  return () => off(p, fn);
}

export function once(pattern, fn, opts = {}) {
  const p = normTopic(pattern);
  if (!p || !isFn(fn)) return () => {};

  if (!state.onceListeners.has(p)) state.onceListeners.set(p, new Set());
  state.onceListeners.get(p).add(fn);

  // optional replay for once: call first matching buffered event and then unsubscribe
  const replay = !!opts.replay || !!state.config.buffer?.replayOnSubscribe;
  if (replay && state.config.buffer?.enabled && state.buffer.length) {
    const evt = state.buffer
      .slice()
      .reverse()
      .find((e) => topicMatches(p, e.topic));
    if (evt) {
      try {
        fn(deepClone(evt.payload), deepClone(evt.meta), deepClone(evt));
      } finally {
        offOnce(p, fn);
      }
    }
  }

  return () => offOnce(p, fn);
}

export function off(pattern, fn) {
  const p = normTopic(pattern);
  const set = state.listeners.get(p);
  if (!set) return false;
  set.delete(fn);
  if (set.size === 0) state.listeners.delete(p);
  return true;
}

export function offOnce(pattern, fn) {
  const p = normTopic(pattern);
  const set = state.onceListeners.get(p);
  if (!set) return false;
  set.delete(fn);
  if (set.size === 0) state.onceListeners.delete(p);
  return true;
}

/**
 * Add middleware: (ctx, next) => any
 * ctx = { topic, payload, meta, evt }
 */
export function use(mw) {
  if (!isFn(mw)) return () => {};
  state.middleware.add(mw);
  return () => state.middleware.delete(mw);
}

/**
 * Publish an event.
 * @param {string} topic
 * @param {*} payload
 * @param {object} meta (merged into event meta)
 */
export function publish(topic, payload = null, meta = {}) {
  const t = normTopic(topic);
  if (!t || !state.config.enabled) return null;

  const suppressed = computeSuppressedMeta();
  const evt = {
    id: makeId("ab"),
    topic: t,
    payload: deepClone(payload),
    meta: {
      id: makeId("meta"),
      atISO:
        nowISO && typeof nowISO === "function"
          ? nowISO()
          : new Date().toISOString(),
      suppressed,
      source: SOURCE,
      ...(isPlainObject(meta) ? deepClone(meta) : {}),
    },
  };

  bufferPush(evt);

  // forward to shared eventBus (best-effort)
  if (state.config.forwardToEventBus && !meta?._internal) {
    void ensureForwardBus().then(() => {
      const bus = state.eventBus;
      if (!bus) return;
      try {
        if (typeof bus.emit === "function") bus.emit(t, evt.payload, evt.meta);
        else if (typeof bus.publish === "function")
          bus.publish(t, evt.payload, evt.meta);
      } catch {
        // ignore
      }
    });
  }

  // Run middleware chain -> handlers
  const runHandlers = () => dispatch(evt);

  if (state.config.middleware?.enabled && state.middleware.size) {
    const stack = Array.from(state.middleware);
    let idx = -1;

    const next = () => {
      idx += 1;
      if (idx >= stack.length) return runHandlers();
      const mw = stack[idx];
      return mw(
        { topic: evt.topic, payload: evt.payload, meta: evt.meta, evt },
        next
      );
    };

    try {
      next();
    } catch (e) {
      if (state.config.errorHandling?.swallow) emitError(e, t, evt);
      else throw e;
    }
  } else {
    try {
      runHandlers();
    } catch (e) {
      if (state.config.errorHandling?.swallow) emitError(e, t, evt);
      else throw e;
    }
  }

  return evt;
}

function dispatch(evt) {
  const t = evt.topic;

  const handlers = getMatchingHandlers(state.listeners, t);
  const onceHandlers = getMatchingHandlers(state.onceListeners, t);

  const onError = (e) => {
    if (state.config.errorHandling?.swallow) emitError(e, t, evt);
    else throw e;
  };

  for (const h of handlers) {
    safeInvoke(
      h.fn,
      [deepClone(evt.payload), deepClone(evt.meta), deepClone(evt)],
      onError
    );
  }

  for (const h of onceHandlers) {
    try {
      h.fn(deepClone(evt.payload), deepClone(evt.meta), deepClone(evt));
    } catch (e) {
      onError(e);
    } finally {
      offOnce(h.pattern, h.fn);
    }
  }
}

/* --------------------------------- Buffer ---------------------------------- */

export function getBufferedEvents(pattern = "*", opts = {}) {
  const p = normTopic(pattern) || "*";
  const limit = opts.limit != null ? clamp(opts.limit, 0, 50_000) : null;
  const arr = state.buffer.filter((evt) => topicMatches(p, evt.topic));
  const out = limit != null ? arr.slice(-limit) : arr;
  return deepClone(out);
}

export function clearBuffer() {
  state.buffer = [];
  return true;
}

/* ---------------------------------- RPC ------------------------------------ */
/**
 * Register a handler for RPC calls.
 * method: string
 * handler: async (payload, meta) => any
 */
export function handle(method, handler) {
  const m = normTopic(method);
  if (!m || !isFn(handler)) return () => {};
  state.rpcHandlers.set(m, handler);
  return () => state.rpcHandlers.delete(m);
}

/**
 * Call a method.
 * - This is local to the bus (not network).
 * - Emits automation.rpc.request / automation.rpc.response
 */
export async function ask(method, payload = null, opts = {}) {
  const m = normTopic(method);
  if (!m) throw new Error("ask() requires method");

  const timeoutMs = clamp(
    opts.timeoutMs ?? state.config.rpc?.defaultTimeoutMs ?? 10_000,
    100,
    60_000
  );

  const requestId = makeId("rpc");
  publish("automation.rpc.request", payload, { requestId, method: m });

  const handler = state.rpcHandlers.get(m);
  if (!handler) {
    const err = new Error(`No RPC handler registered for method "${m}"`);
    publish(
      "automation.rpc.response",
      { ok: false, error: err.message },
      { requestId, method: m }
    );
    throw err;
  }

  const timeout = new Promise((_, rej) =>
    setTimeout(
      () => rej(new Error(`RPC timeout after ${timeoutMs}ms (${m})`)),
      timeoutMs
    )
  );

  try {
    const result = await Promise.race([
      Promise.resolve(handler(payload, { requestId, method: m })),
      timeout,
    ]);
    publish(
      "automation.rpc.response",
      { ok: true, result },
      { requestId, method: m }
    );
    return result;
  } catch (e) {
    publish(
      "automation.rpc.response",
      { ok: false, error: e?.message || String(e) },
      { requestId, method: m }
    );
    throw e;
  }
}

/* ----------------------------- Convenience Topics --------------------------- */

export const TOPICS = Object.freeze({
  // ingest/layers
  INGEST_UPLOADED: "ingest.uploaded",
  ARTIFACT_CREATED: "artifact.created",
  PARSE_STARTED: "parse.started",
  PARSE_DONE: "parse.done",
  METHODMAP_DONE: "methodmap.done",
  BLUEPRINT_DONE: "blueprint.done",
  SESSION_INTENT: "session.intent",

  // sessions
  SESSION_STARTED: "session.started",
  SESSION_STEP_CHANGED: "session.step.changed",
  SESSION_DONE: "session.done",

  // errors
  ERROR: "automation.error",
});

/* -------------------------------- Default Bus ------------------------------ */
/**
 * Default export is a singleton bus API
 */
const AutomationBus = Object.freeze({
  SOURCE,
  DEFAULTS,

  configure: configureAutomationBus,
  getConfig,

  on,
  once,
  off,
  offOnce,

  use,

  publish,
  emit: publish, // alias

  getBufferedEvents,
  clearBuffer,

  handle,
  ask,

  TOPICS,
});

export default AutomationBus;
