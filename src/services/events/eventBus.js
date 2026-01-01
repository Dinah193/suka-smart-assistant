// C:\Users\larho\suka-smart-assistant\src\services\events\eventBus.js
// Shared orchestration bus for ALL SSA domain events
// -----------------------------------------------------------------------------
// PURPOSE
// SSA is event-driven. Everything flows through here:
//
//   imports → intelligence → automation → (optional) hub export
//   └── import.parsed → inventory.updated → ... → session.draftReady
//
// This bus makes that possible. It:
//
// 1. Normalizes event names (dots → slashes).
// 2. Enforces a CONSISTENT PAYLOAD SHAPE:
//
//      {
//        type: "<event-name>",     // normalized
//        ts: "<ISO timestamp>",    // Date.toISOString()
//        source: "<emitter-module-or-domain>",
//        data: { ...your payload... }
//      }
//
//    If a caller passes that shape already, we do NOT re-wrap it.
//    This is important so your engines and shims can directly call
//    exportToHubIfEnabled(eventPayload) or postMessage(eventPayload).
//
// 3. Supports wildcard subscriptions ("inventory/**", "scan/*", "session/**").
// 4. Supports sticky events (last payload replay on new listeners).
// 5. Supports DOM bridge (CustomEvent → bus) for Scan • Compare • Trust.
// 6. Supports request/response (ask/respond) for local RPC-ish calls.
// 7. Supports small orchestration glue for your sessions + NBA.
// 8. Supports AI “shim” orchestration via agent.* events, so Reasoners and
//    skill shims can run in the background while SessionRunner or domain
//    pages keep going.
// 9. Supports a BroadcastChannel bridge so SessionRunner shims or workers
//    can keep handling events even when the main UI route changes.
//
// SAFE TO IMPORT ANYWHERE in SSA (main window, worker, SessionRunner shim).
//
// NOTE: This file does NOT talk to the Hub. That is done per-engine so SSA
//       can run even if the Hub is down. This bus ONLY emits app-level events.

/**
 * @typedef {Object} EventEnvelope
 * @property {string} type    Event name (normalized "a/b")
 * @property {string} ts      ISO8601 timestamp
 * @property {string} source  Logical source (module/domain/shim)
 * @property {any}    data    Arbitrary payload data (domain-specific)
 */

// -----------------------------------------------------------------------------
// Internal state
// -----------------------------------------------------------------------------

const _listeners = new Set();      // { pattern, handler, opts }
const _sticky = new Map();         // exactEventName -> last CANONICAL payload
let _debug = false;

const MAX_QUEUE = 1000;
let _emitCount = 0;

const _debouncers = new Map();     // key -> { timer, ... }
const _beforeEmit = new Set();     // middleware
const _afterEmit = new Set();      // middleware

const _timeline = [];
const TIMELINE_MAX = 300;

// BroadcastChannel bridge (optional, for shims/workers)
let _broadcastChannel = null;
let _broadcastBridgeDispose = null;

// Validators (non-invasive; used only for dev warnings)
function _isPlainObject(v) {
  return v && typeof v === "object" && !Array.isArray(v);
}
/** @param {EventEnvelope} e */
function _isLikelyEnvelope(e) {
  return _isPlainObject(e) && typeof e.type === "string" && typeof e.ts === "string" && "data" in e;
}
/** @param {EventEnvelope} e */
function _validateEnvelope(e) {
  if (!_isPlainObject(e)) return false;
  if (!e.type || typeof e.type !== "string") return false;
  if (!e.ts || typeof e.ts !== "string" || Number.isNaN(Date.parse(e.ts))) return false;
  if (!e.source || typeof e.source !== "string") return false;
  // data can be anything
  return true;
}

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

/**
 * Subscribe to an event pattern.
 * pattern: exact or wildcard (e.g. "recipes/*", "inventory/**")
 * handler: (canonicalPayload, meta) => ...
 * opts: { once?:boolean, priority?:number, replayLast?:boolean }
 */
export function on(pattern, handler, opts = {}) {
  const entry = {
    pattern: normalize(pattern),
    handler,
    opts: {
      once: !!opts.once,
      priority: Number.isFinite(opts.priority) ? opts.priority : 0,
      replayLast: !!opts.replayLast,
    },
  };

  _listeners.add(entry);

  // Sticky replay (snapshot) so we don't mutate while iterating
  if (entry.opts.replayLast) {
    try {
      if (isWildcard(entry.pattern)) {
        const keys = Array.from(_sticky.keys());
        const replayKeys = keys.filter((k) => patternMatch(entry.pattern, k)).sort();
        for (const k of replayKeys) {
          const payload = _sticky.get(k);
          safeCall(entry, k, payload, { event: k, time: Date.now() });
        }
      } else if (_sticky.has(entry.pattern)) {
        const payload = _sticky.get(entry.pattern);
        safeCall(entry, entry.pattern, payload, { event: entry.pattern, time: Date.now() });
      }
      if (entry.opts.once) {
        _listeners.delete(entry);
        return () => {};
      }
    } catch (e) {
      log("replay error for", entry.pattern, e);
    }
  }

  return () => off(entry.pattern, handler);
}

/** sugar */
export function once(pattern, handler, priority = 0) {
  return on(pattern, handler, { once: true, priority, replayLast: false });
}

/** unsubscribe */
export function off(pattern, handler) {
  const p = normalize(pattern);
  for (const l of Array.from(_listeners)) {
    if (l.pattern === p && l.handler === handler) {
      _listeners.delete(l);
    }
  }
}

/**
 * EMIT — synchronous, non-blocking
 * We ALWAYS try to wrap into our canonical SSA payload shape if the caller
 * didn't already do it.
 *
 * @param {string} event
 * @param {any} payload
 * @param {{sticky?:boolean, traceId?:string, source?:string}} [opts]
 */
export function emit(event, payload, opts = {}) {
  _emitCount++;
  if (_emitCount > MAX_QUEUE) {
    _emitCount = 0;
    console.warn("[eventBus] High emit volume detected; consider batching.");
  }

  const name = normalize(event);
  const time = Date.now();
  const iso = new Date(time).toISOString();
  const traceId = String(opts?.traceId || genId());
  const source = opts?.source || detectSourceFromName(name);

  // Normalize to canonical
  const canonical = toCanonicalPayload(name, payload, iso, source);

  // sticky
  if (opts.sticky && !isWildcard(name)) _sticky.set(name, canonical);

  // run before middleware
  const meta = { event: name, time, traceId, iso, source };
  const maybe = runBefore(name, canonical, meta);
  if (maybe?.skip) return;
  const finalPayload = Object.prototype.hasOwnProperty.call(maybe || {}, "payload")
    ? maybe.payload
    : canonical;

  // dispatch
  const listeners = matchedListeners(name);
  for (const entry of listeners) {
    safeCall(entry, name, finalPayload, meta);
  }

  // run after middleware
  runAfter(name, finalPayload, meta);
  recordTimeline({ t: time, event: name, dir: "emit", traceId, size: listeners.length });
}

/**
 * EMIT ASYNC — awaits all handlers
 */
export async function emitAsync(event, payload, opts = {}) {
  _emitCount++;
  if (_emitCount > MAX_QUEUE) {
    _emitCount = 0;
    console.warn("[eventBus] High emit volume detected; consider batching.");
  }

  const name = normalize(event);
  const time = Date.now();
  const iso = new Date(time).toISOString();
  const traceId = String(opts?.traceId || genId());
  const source = opts?.source || detectSourceFromName(name);
  const canonical = toCanonicalPayload(name, payload, iso, source);

  if (opts.sticky && !isWildcard(name)) _sticky.set(name, canonical);

  const meta = { event: name, time, traceId, iso, source };
  const maybe = runBefore(name, canonical, meta);
  if (maybe?.skip) return;
  const finalPayload = Object.prototype.hasOwnProperty.call(maybe || {}, "payload")
    ? maybe.payload
    : canonical;

  const listeners = matchedListeners(name);
  const tasks = [];
  for (const entry of listeners) {
    tasks.push(Promise.resolve().then(() => safeCall(entry, name, finalPayload, meta)));
  }
  await Promise.allSettled(tasks);

  runAfter(name, finalPayload, meta);
  recordTimeline({ t: time, event: name, dir: "emitAsync", traceId, size: listeners.length });
}

/**
 * Debounced emit — coalesces bursts
 */
export function emitDebounced(event, payload, opts = {}) {
  const name = normalize(event);
  const {
    wait = 250,
    leading = false,
    trailing = true,
    maxWait = 1000,
    sticky = false,
    key = name,
    traceId,
    source,
  } = opts;

  let state = _debouncers.get(key);
  const now = Date.now();

  if (!state) {
    state = { timer: null, lastInvoke: 0, leadingInvoked: false, queuedArgs: null, startTs: now };
    _debouncers.set(key, state);
  }

  state.queuedArgs = { event: name, payload, sticky, traceId, source };

  const invoke = () => {
    state.lastInvoke = Date.now();
    const args = state.queuedArgs;
    state.queuedArgs = null;
    state.leadingInvoked = false;
    emit(args.event, args.payload, {
      sticky: args.sticky,
      traceId: args.traceId,
      source: args.source,
    });
  };

  const shouldInvokeLeading = leading && !state.leadingInvoked;
  const hitMaxWait = maxWait > 0 && now - state.startTs >= maxWait;

  if (shouldInvokeLeading) {
    state.leadingInvoked = true;
    invoke();
  }

  if (state.timer) clearTimeout(state.timer);

  if (hitMaxWait) {
    state.startTs = now;
    if (trailing && !shouldInvokeLeading) {
      invoke();
    }
    state.timer = setTimeout(() => {
      if (trailing && state.queuedArgs) invoke();
      state.timer = null;
    }, wait);
  } else {
    state.timer = setTimeout(() => {
      if (trailing && state.queuedArgs) invoke();
      state.timer = null;
    }, wait);
  }
}

/** bulk emit */
export function emitBatch(batch) {
  for (const b of batch) emit(b.event, b.payload, b.opts);
}

/**
 * Convenience emit helper with consistent shape.
 * @param {string} type
 * @param {string} source
 * @param {any} data
 * @returns {void}
 */
export function emitEvent(type, source, data) {
  emit(type, data, { source });
}

/**
 * waitFor — promise-based listener
 */
export function waitFor(pattern, predicate, timeoutMs = 15000, signal) {
  const pat = normalize(pattern);
  return new Promise((resolve, reject) => {
    let settled = false;

    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      try {
        unsub();
      } catch {}
      if (timer) clearTimeout(timer);
      if (signal) {
        try {
          signal.removeEventListener("abort", onAbort);
        } catch {}
      }
      fn(arg);
    };

    const onAbort = () =>
      finish(reject, new Error(`waitFor aborted for pattern "${pat}"`));

    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            finish(reject, new Error(`waitFor timeout for pattern "${pat}"`));
          }, timeoutMs)
        : null;

    const unsub = on(
      pat,
      (payload, meta) => {
        try {
          if (!predicate || predicate(payload, meta)) {
            finish(resolve, { payload, meta });
          }
        } catch (e) {
          finish(reject, e);
        }
      },
      { priority: 100 }
    );

    if (signal) signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * ask/respond mini-RPC
 */
export function ask(baseEvent, payload, timeoutMs = 15000, signal) {
  const base = normalize(baseEvent);
  const id = genId();
  const req = `${base}:req`;
  const res = `${base}:res:${id}`;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      try {
        off(res, handler);
      } catch {}
      if (timer) clearTimeout(timer);
      if (signal) {
        try {
          signal.removeEventListener("abort", onAbort);
        } catch {}
      }
      fn(arg);
    };
    const onAbort = () =>
      finish(reject, new Error(`ask aborted for "${base}"`));
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            finish(reject, new Error(`ask timeout for "${base}"`));
          }, timeoutMs)
        : null;

    const handler = (answer) => finish(resolve, answer);

    on(res, handler, { once: true, priority: 100 });
    emit(req, { id, payload }, { source: "eventBus.ask" });

    if (signal) signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function respond(baseEvent, handler) {
  const base = normalize(baseEvent);
  const req = `${base}:req`;
  const h = async (msg, meta) => {
    try {
      const { id, payload } = msg?.data || msg || {};
      const answer = await handler(payload, meta);
      emit(`${base}:res:${id}`, answer, { source: "eventBus.respond" });
    } catch (e) {
      emit(
        `${base}:res:${msg?.id}`,
        { ok: false, error: String(e?.message || e) },
        { source: "eventBus.respond" }
      );
    }
  };
  return on(req, h);
}

/**
 * namespaced channel: createChannel("cooking").emit("requestSession", {...})
 */
export function createChannel(ns) {
  const prefix = normalize(String(ns).replace(/\/+$/g, ""));
  return {
    emit: (name, payload, opts) => emit(`${prefix}/${normalize(name)}`, payload, opts),
    emitAsync: (name, payload, opts) =>
      emitAsync(`${prefix}/${normalize(name)}`, payload, opts),
    emitDebounced: (name, payload, opts) =>
      emitDebounced(`${prefix}/${normalize(name)}`, payload, opts),
    on: (name, handler, opts) =>
      on(`${prefix}/${normalize(name)}`, handler, opts),
    once: (name, handler, priority) =>
      once(`${prefix}/${normalize(name)}`, handler, priority),
    waitFor: (name, predicate, timeout, signal) =>
      waitFor(`${prefix}/${normalize(name)}`, predicate, timeout, signal),
    ask: (name, payload, timeout, signal) =>
      ask(`${prefix}/${normalize(name)}`, payload, timeout, signal),
    respond: (name, handler) =>
      respond(`${prefix}/${normalize(name)}`, handler),
  };
}

/**
 * domain-aware channel that auto-adds {domain} to data
 */
export function createDomainChannel(domain) {
  const ch = createChannel(domain);
  const ensure = (p) =>
    p && typeof p === "object" && p.data
      ? { ...p, data: { ...p.data, domain } }
      : toCanonicalPayload(domain, p, new Date().toISOString(), domain);
  return {
    emit: (name, payload, opts) => ch.emit(name, ensure(payload), opts),
    emitAsync: (name, payload, opts) => ch.emitAsync(name, ensure(payload), opts),
    emitDebounced: (name, payload, opts) =>
      ch.emitDebounced(name, ensure(payload), opts),
    on: ch.on,
    once: ch.once,
    waitFor: ch.waitFor,
    ask: (name, payload, timeout, signal) =>
      ch.ask(name, ensure(payload), timeout, signal),
    respond: ch.respond,
  };
}

/** pipe pattern → prefix */
export function pipe(fromPattern, toPrefix) {
  const pref = normalize(toPrefix);
  const unsub = on(
    fromPattern,
    (payload, meta) => {
      emit(
        `${pref}/${meta.event}`,
        { ...payload.data, pipedFrom: meta.event },
        { traceId: meta.traceId, source: "eventBus.pipe" }
      );
    },
    { priority: -10, replayLast: false }
  );
  return () => unsub();
}

// -----------------------------------------------------------------------------
// Debug / stats / reset
// -----------------------------------------------------------------------------

export function setDebug(v) {
  _debug = !!v;
}

export function useMiddleware({ beforeEmit, afterEmit } = {}) {
  if (beforeEmit) _beforeEmit.add(beforeEmit);
  if (afterEmit) _afterEmit.add(afterEmit);
  return () => {
    if (beforeEmit) _beforeEmit.delete(beforeEmit);
    if (afterEmit) _afterEmit.delete(afterEmit);
  };
}

export function stats() {
  return {
    listeners: _listeners.size,
    sticky: _sticky.size,
    debouncers: _debouncers.size,
    timeline: _timeline.slice(-10),
  };
}

export function clearSticky(pattern) {
  const pat = pattern ? normalize(pattern) : null;
  if (!pat) return _sticky.clear();
  for (const k of Array.from(_sticky.keys())) {
    if (patternMatch(pat, k)) _sticky.delete(k);
  }
}

export function reset() {
  _listeners.clear();
  _sticky.clear();
  _debouncers.clear();
  _beforeEmit.clear();
  _afterEmit.clear();
  _timeline.length = 0;
  _emitCount = 0;
}

// -----------------------------------------------------------------------------
// Internals
// -----------------------------------------------------------------------------

function normalize(name) {
  return String(name)
    .replace(/\./g, "/")
    .replace(/\/{2,}/g, "/")
    .replace(/^\/|\/$/g, "");
}
function isWildcard(pat) {
  return pat.includes("*");
}
function matchedListeners(event) {
  const arr = [];
  for (const l of _listeners) {
    if (patternMatch(l.pattern, event)) arr.push(l);
  }
  arr.sort((a, b) => b.opts.priority - a.opts.priority);
  return arr;
}
function patternMatch(pattern, event) {
  if (pattern === event) return true;
  const p = pattern.split("/");
  const e = event.split("/");
  const starStar = p[p.length - 1] === "**";
  if (starStar) {
    const head = p.slice(0, -1);
    if (head.length > e.length) return false;
    for (let i = 0; i < head.length; i++) {
      if (p[i] === "*") continue;
      if (p[i] !== e[i]) return false;
    }
    return true;
  }
  if (p.length !== e.length) return false;
  for (let i = 0; i < p.length; i++) {
    if (p[i] === "*") continue;
    if (p[i] !== e[i]) return false;
  }
  return true;
}
function safeCall(entry, event, payload, meta = { event, time: Date.now() }) {
  try {
    const res = entry.handler(payload, meta);
    if (entry.opts.once) _listeners.delete(entry);
    return res;
  } catch (e) {
    console.error(`[eventBus] handler error for "${event}"`, e);
    return undefined;
  } finally {
    if (_debug) log("emit", event, payload, meta);
  }
}
function genId() {
  return (
    Math.random().toString(36).slice(2) + Date.now().toString(36)
  );
}
function log(...args) {
  if (_debug) console.debug("[eventBus]", ...args);
}
function runBefore(name, payload, meta) {
  let result = undefined;
  for (const mw of _beforeEmit) {
    try {
      const out = mw(name, payload, meta);
      if (out && typeof out === "object") result = { ...(result || {}), ...out };
    } catch (e) {
      console.warn("[eventBus] beforeEmit middleware error", e);
    }
  }
  return result;
}
function runAfter(name, payload, meta) {
  for (const mw of _afterEmit) {
    try {
      mw(name, payload, meta);
    } catch (e) {
      console.warn("[eventBus] afterEmit middleware error", e);
    }
  }
}
function recordTimeline(entry) {
  _timeline.push(entry);
  if (_timeline.length > TIMELINE_MAX) {
    _timeline.splice(0, _timeline.length - TIMELINE_MAX);
  }
}
function detectSourceFromName(name) {
  // e.g. "garden/harvestLogged" → "garden"
  const parts = name.split("/");
  return parts[0] || "eventBus";
}
function toCanonicalPayload(type, payload, iso, source) {
  // if already canonical, return as-is (with a dev-time validation only)
  if (_isLikelyEnvelope(payload)) {
    if (
      typeof process !== "undefined" &&
      process?.env?.NODE_ENV !== "production" &&
      !_validateEnvelope(/** @type {any} */ (payload))
    ) {
      // eslint-disable-next-line no-console
      console.warn(
        "[eventBus] received a likely canonical envelope with invalid fields:",
        payload
      );
    }
    return payload;
  }
  return {
    type,
    ts: iso,
    source,
    data:
      payload && typeof payload === "object"
        ? payload
        : { value: payload },
  };
}

// -----------------------------------------------------------------------------
// Event name registry (for discoverability)
// -----------------------------------------------------------------------------
export const Events = {
  /* Imports / Intelligence / Sessions */
  IMPORT_PARSED: "import/parsed",
  IMPORT_SESSION_SAVED: "import/sessionSaved",

  /* Inventory / Storehouse */
  INVENTORY_UPDATED: "inventory/updated",
  INVENTORY_SHORTAGE_DETECTED: "inventory/shortageDetected",
  STOREHOUSE_PLAN_READY: "storehouse/planReady",

  /* Meals / Cooking */
  RECIPES_CONSOLIDATED: "recipes/consolidated",
  MEALPLAN_UPDATED: "mealplan/updated",
  COOKING_REQUEST_SESSION: "cooking/requestSession",
  COOKING_DRAFT_READY: "cooking/draftReady",

  /* Cleaning */
  CLEANING_TASKS_SAVED: "cleaning/tasksSaved",
  CLEANING_REQUEST_SESSION: "cleaning/requestSession",
  CLEANING_DRAFT_READY: "cleaning/draftReady",

  /* Garden / Animals / Preservation */
  GARDEN_HARVEST_LOGGED: "garden/harvestLogged",
  GARDEN_PLAN_GENERATE_REQ: "garden/plan.generate.requested",
  ANIMAL_HEALTH_UPDATED: "animals/healthUpdated",
  PRESERVATION_COMPLETED: "preservation/completed",

  /* Shared sessions
   * These are the canonical SessionRunner lifecycle events.
   * SessionRunner shims should emit these via the eventBus so the
   * rest of SSA (storehouse, analytics, Hub exporter) can listen.
   */
  SESSION_DRAFT_READY: "session/draftReady",
  SESSION_APPROVED: "session/approved",
  SESSION_DISCARDED: "session/discarded",
  SESSION_ERROR: "session/error",

  SESSION_STARTED: "session/started",
  SESSION_STEP_CHANGED: "session/step.changed",
  SESSION_PAUSED: "session/paused",
  SESSION_RESUMED: "session/resumed",
  SESSION_COMPLETED: "session/completed",
  SESSION_ABORTED: "session/aborted",
  SESSION_EXPORTED: "session/exported",

  /* Grocery / Coupons */
  GROCERY_LIST_READY: "grocery/listReady",
  COUPONS_STACK_READY: "coupons/stackReady",

  /* UI / NBA */
  UI_TOAST: "ui/toast",
  UI_PROGRESS: "ui/progress",
  UI_UNDO_OFFERED: "ui/undoOffered",
  UI_UNDO_TRIGGERED: "ui/undoTriggered",
  UI_NBA_SUGGESTED: "ui/nbaSuggested",
  UI_MODAL_OPEN: "ui/modalOpen",
  UI_MODAL_CLOSE: "ui/modalClose",

  /* Scan • Compare • Trust */
  SCAN_OPEN: "scan/open",
  SCAN_CLOSE: "scan/close",
  SCAN_START: "scan/start",
  SCAN_IMPORT: "scan/import",
  SCAN_RESULT: "scan/result",
  PRODUCT_CANDIDATES_READY: "scan/candidatesReady",
  PRODUCT_RESOLVED: "scan/resolved",
  RANKING_READY: "scan/rankingReady",
  RECALL_FLAGS_READY: "safety/recallFlagsReady",
  COMPARE_READY: "compare/ready",

  /* Favorites / Schedules */
  FAVORITES_TOGGLED: "favorites/toggled",
  FAVORITES_SYNCED: "favorites/synced",
  SCHEDULE_SAVED: "schedule/saved",
  SCHEDULE_DELETED: "schedule/deleted",

  /* Agent / Reasoner / Shim orchestration
   *
   * These events form the “shim boundary” for AI skills. They are designed
   * so that:
   * - the Orchestrator/Reasoner can request work,
   * - a specific shim (cooking, cleaning, garden, animal, preservation, etc.)
   *   can pick it up, optionally consult AgentCacheRepo, and
   * - results/errors can be streamed back without tightly coupling callers
   *   to any specific model/provider.
   *
   * Typical payload shape (canonical envelope .data):
   *
   *   agent/invocation.requested:
   *     { id, domain, skill, shimName, input, meta }
   *
   *   agent/invocation.started:
   *     { id, domain, skill, shimName }
   *
   *   agent/cache.hit | agent/cache.miss:
   *     { id, cacheKey, domain, skill, shimName, entry? }
   *
   *   agent/invocation.completed:
   *     { id, domain, skill, shimName, output, usage?, cacheKey? }
   *
   *   agent/invocation.failed:
   *     { id, domain, skill, shimName, error, retryable, cacheKey? }
   *
   *   agent/shim.health:
   *     { shimName, ok, lastError?, latencyMs? }
   */
  AGENT_INVOCATION_REQUESTED: "agent/invocation.requested",
  AGENT_INVOCATION_STARTED: "agent/invocation.started",
  AGENT_INVOCATION_COMPLETED: "agent/invocation.completed",
  AGENT_INVOCATION_FAILED: "agent/invocation.failed",
  AGENT_CACHE_HIT: "agent/cache.hit",
  AGENT_CACHE_MISS: "agent/cache.miss",
  AGENT_SHIM_HEALTH: "agent/shim.health",
};

// -----------------------------------------------------------------------------
// Opinionated glue (kept small; extend in /src/services/events/glue/*.js if needed)
// -----------------------------------------------------------------------------
// meals / recipes → cooking session
on(
  Events.RECIPES_CONSOLIDATED,
  ({ data, ts, source }) => {
    emitDebounced(
      Events.COOKING_REQUEST_SESSION,
      { ...data, ts, from: source },
      { wait: 300, maxWait: 1200 }
    );
  },
  { priority: 1 }
);

on(
  Events.MEALPLAN_UPDATED,
  ({ data, ts, source }) => {
    emitDebounced(
      Events.COOKING_REQUEST_SESSION,
      { ...data, ts, from: source },
      { wait: 300, maxWait: 1200 }
    );
  },
  { priority: 1 }
);

// cleaning → cleaning session
on(
  Events.CLEANING_TASKS_SAVED,
  ({ data, ts, source }) => {
    emitDebounced(
      Events.CLEANING_REQUEST_SESSION,
      { ...data, ts, from: source },
      { wait: 300, maxWait: 1200 }
    );
  },
  { priority: 1 }
);

// forward domain-drafts to shared draft tray
on(Events.COOKING_DRAFT_READY, ({ data }) => {
  emit(
    Events.SESSION_DRAFT_READY,
    { draft: data?.draft ?? data },
    { source: "eventBus.glue" }
  );
});
on(Events.CLEANING_DRAFT_READY, ({ data }) => {
  emit(
    Events.SESSION_DRAFT_READY,
    { draft: data?.draft ?? data },
    { source: "eventBus.glue" }
  );
});

// inventory undo + NBA
on(Events.INVENTORY_UPDATED, ({ data }) => {
  const diffs = data?.diffs || [];
  emit(
    Events.UI_UNDO_OFFERED,
    { label: "Undo inventory change", ttlMs: 8000 },
    { source: "eventBus.inventory" }
  );

  const handler = () => {
    try {
      const inverse = Array.isArray(diffs)
        ? diffs.map((d) => ({ ...d, delta: -Number(d.delta || 0) }))
        : [];
      emit(
        Events.INVENTORY_UPDATED,
        { diffs: inverse, source: "undo" },
        { source: "eventBus.inventory" }
      );
      emit(Events.UI_TOAST, {
        variant: "info",
        title: "Inventory restored",
        message: "Your last change was undone.",
      });
    } finally {
      off(Events.UI_UNDO_TRIGGERED, handler);
    }
  };
  on(Events.UI_UNDO_TRIGGERED, handler, { once: true, priority: 50 });

  const used = (diffs || []).some((d) => Number(d.delta) < 0);
  if (used) {
    emit(Events.UI_NBA_SUGGESTED, {
      label: "Generate Labels",
      hint: "Print/update storage labels",
      route: "/tier2/household/inventory#labels",
    });
  } else {
    emit(Events.UI_NBA_SUGGESTED, {
      label: "Open Grocery List",
      hint: "Fill gaps from recent changes",
      route: "/tier2/household/meals#grocery",
    });
  }
});

// SCT glue
on(Events.SCAN_RESULT, ({ data }) => {
  emit(Events.UI_TOAST, {
    variant: "info",
    title: "Scan captured",
    message: data?.source ? `Source: ${data.source}` : "Processing...",
  });
  emitDebounced(
    Events.PRODUCT_CANDIDATES_READY,
    { items: Array.isArray(data) ? data : [data] },
    { wait: 100, maxWait: 600 }
  );
});

on(Events.PRODUCT_RESOLVED, ({ data }) => {
  emit(Events.UI_PROGRESS, {
    context: "compare",
    step: 1,
    total: 2,
    label: "Analyzing offers...",
  });
  emit(Events.COUPONS_STACK_READY, data);
});

on(Events.RANKING_READY, ({ data }) => {
  emit(Events.UI_PROGRESS, {
    context: "compare",
    step: 2,
    total: 2,
    label: "Comparison ready",
  });
  emit(Events.COMPARE_READY, data, { sticky: true });
  emit(Events.UI_NBA_SUGGESTED, {
    label: "Add to Meal Plan",
    route: "/tier2/household/meals#planner",
    hint: "Save best picks to a session",
  });
});

// favorites feedback
on(Events.FAVORITES_TOGGLED, ({ data }) => {
  const { entity, id, on } = data || {};
  const noun =
    entity === "schedule"
      ? "Schedule"
      : entity === "session"
      ? "Session"
      : "Item";
  emit(Events.UI_TOAST, {
    variant: on ? "success" : "info",
    title: on ? `${noun} saved` : `${noun} removed`,
    message: on
      ? "Added to your favorites"
      : "Removed from favorites",
  });
  emitDebounced(
    Events.FAVORITES_SYNCED,
    {},
    { wait: 300, maxWait: 1200, key: "fav-sync" }
  );
});

// -----------------------------------------------------------------------------
// DOM Bridge (for ScanMount / mobile app overlays)
// -----------------------------------------------------------------------------
export function bridgeDOM() {
  if (typeof document === "undefined") return () => {};
  const map = [
    ["scan:open", Events.SCAN_OPEN],
    ["scan:close", Events.SCAN_CLOSE],
    ["scan:start", Events.SCAN_START],
    ["scan:import", Events.SCAN_IMPORT],
    ["scan:result", Events.SCAN_RESULT],
  ];
  const handlers = map.map(([domEvt, busEvt]) => {
    const h = (e) => emit(busEvt, e?.detail ?? {}, { source: "domBridge" });
    document.addEventListener(domEvt, h);
    return () => document.removeEventListener(domEvt, h);
  });
  return () => handlers.forEach((u) => u());
}

// -----------------------------------------------------------------------------
// BroadcastChannel bridge (shim-friendly, for background/session shims)
// -----------------------------------------------------------------------------
// This allows SessionRunner shims, Web Workers, or other tabs to share
// the same event envelopes. It is safe to call multiple times; later calls
// will tear down the previous bridge and replace it.
//
// Typical usage (main app root):
//   attachBroadcastChannelBridge("ssa-event-bus");
//
// In a SessionRunner shim / worker:
//   attachBroadcastChannelBridge("ssa-event-bus");
//   eventBus.on("session/**", ...);
//
// IMPORTANT: to avoid infinite loops, events that arrive from the bridge
// are re-emitted with source === "broadcast". The bridge middleware only
// re-broadcasts events whose meta.source !== "broadcast".
export function attachBroadcastChannelBridge(channelName = "ssa-event-bus") {
  // tear down any existing bridge first
  if (_broadcastBridgeDispose) {
    try { _broadcastBridgeDispose(); } catch {}
    _broadcastBridgeDispose = null;
  }
  if (_broadcastChannel) {
    try { _broadcastChannel.close(); } catch {}
    _broadcastChannel = null;
  }

  const globalAny = typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : null;
  if (!globalAny || typeof globalAny.BroadcastChannel === "undefined") {
    // Unsupported; no-op bridge.
    return () => {};
  }

  const bc = new globalAny.BroadcastChannel(channelName);
  _broadcastChannel = bc;

  // Forward local events → BroadcastChannel
  const disposeMw = useMiddleware({
    afterEmit: (name, payload, meta) => {
      try {
        // Skip events that are already coming from the broadcast
        if (meta?.source === "broadcast") return;
        if (!_isLikelyEnvelope(payload)) return;
        bc.postMessage(payload);
      } catch (e) {
        if (_debug) console.warn("[eventBus] broadcast afterEmit error", e);
      }
    },
  });

  bc.onmessage = (evt) => {
    const msg = evt?.data;
    if (!_isLikelyEnvelope(msg)) return;
    // Re-emit into the local bus; mark source as broadcast so we don't loop.
    emit(msg.type, msg, { source: "broadcast", sticky: false });
  };

  _broadcastBridgeDispose = () => {
    disposeMw();
    try { bc.close(); } catch {}
    _broadcastChannel = null;
    _broadcastBridgeDispose = null;
  };

  return _broadcastBridgeDispose;
}

// -----------------------------------------------------------------------------
// Auto-enable debug via env if present
// -----------------------------------------------------------------------------
try {
  const v =
    (typeof import.meta !== "undefined" &&
      import.meta.env &&
      import.meta.env.VITE_EVENTBUS_DEBUG) ||
    (typeof process !== "undefined" &&
      process.env &&
      process.env.EVENTBUS_DEBUG);
  if (String(v).toLowerCase() === "true") setDebug(true);
} catch {
  // noop
}

// -----------------------------------------------------------------------------
// Default facade (compat with code expecting a default `eventBus` object)
// -----------------------------------------------------------------------------
export const eventBus = {
  on,
  once,
  off,
  emit,
  emitAsync,
  emitDebounced,
  emitBatch,
  emitEvent, // convenience helper
  waitFor,
  ask,
  respond,
  createChannel,
  createDomainChannel,
  pipe,
  setDebug,
  useMiddleware,
  stats,
  clearSticky,
  reset,
  bridgeDOM,
  attachBroadcastChannelBridge,
  Events,
};

export default eventBus;
