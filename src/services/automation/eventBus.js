// File: C:\Users\larho\suka-smart-assistant\src\services\automation\eventBus.js
/**
 * SSA Automation Event Bus
 * -----------------------------------------------------------------------------
 * A small, browser-safe event bus used by SSA automation + orchestration layers.
 *
 * Why this exists (vs other busses):
 *  - Some projects already have "@/services/events/eventBus" — this file provides a
 *    stable "automation-scoped" bus that:
 *      • is safe in Vite/browser builds
 *      • supports wildcard subscriptions and namespaces
 *      • supports once(), off(), and replay of recent events (optional)
 *      • supports async listeners safely (errors isolated)
 *      • supports "bridge" to another bus if you want a single global bus
 *
 * Usage:
 *  import autoBus from "@/services/automation/eventBus";
 *  const off = autoBus.on("session.started", (evt) => {});
 *  autoBus.emit("session.started", { id: "..." });
 *  off(); // unsubscribe
 *
 * Optional bridge:
 *  autoBus.bridgeTo(globalBus)   // forward all events to globalBus.emit(...)
 *  autoBus.bridgeFrom(globalBus) // listen and re-emit into autoBus
 */

const SOURCE = "services.automation.eventBus";

/* -----------------------------------------------------------------------------
 * Helpers
 * -------------------------------------------------------------------------- */

function safeFn(fn) {
  return typeof fn === "function" ? fn : null;
}

function isObj(x) {
  return x && typeof x === "object" && !Array.isArray(x);
}

function nowMs() {
  return Date.now();
}

function toArr(x) {
  return Array.isArray(x) ? x : x != null ? [x] : [];
}

function normalizeName(name) {
  return String(name || "")
    .trim()
    .replace(/\s+/g, " ");
}

function matchPattern(pattern, name) {
  // pattern supports:
  //  - exact: "a.b.c"
  //  - wildcard: "a.*" or "*.c" or "a.**" (deep)
  //  - global wildcard: "*"
  const p = normalizeName(pattern);
  const n = normalizeName(name);

  if (!p || !n) return false;
  if (p === "*" || p === "**") return true;
  if (p === n) return true;

  // Deep wildcard
  if (p.endsWith(".**")) {
    const prefix = p.slice(0, -3);
    return n === prefix || n.startsWith(prefix + ".");
  }

  // Single-segment wildcard
  const pSeg = p.split(".");
  const nSeg = n.split(".");
  if (pSeg.length !== nSeg.length) return false;

  for (let i = 0; i < pSeg.length; i++) {
    if (pSeg[i] === "*") continue;
    if (pSeg[i] !== nSeg[i]) return false;
  }
  return true;
}

function createId(prefix = "evt") {
  return `${prefix}_${nowMs().toString(16)}_${Math.random()
    .toString(16)
    .slice(2)}`;
}

/* -----------------------------------------------------------------------------
 * Event Bus Factory
 * -------------------------------------------------------------------------- */

/**
 * @param {object} [config]
 * @param {string} [config.name="automationBus"]
 * @param {number} [config.replaySize=0] - store last N events for replay
 * @param {boolean} [config.async=true] - dispatch listeners async via microtasks
 * @param {boolean} [config.strict=false] - throw on invalid inputs
 */
export function createEventBus(config = {}) {
  const cfg = isObj(config) ? config : {};
  const name = String(cfg.name || "automationBus");
  const replaySize = Math.max(0, Number(cfg.replaySize || 0));
  const asyncDispatch = cfg.async !== false; // default true
  const strict = cfg.strict === true;

  /** @type {Map<string, Set<Function>>} */
  const listeners = new Map(); // pattern -> Set(fn)

  /** @type {Map<string, Set<Function>>} */
  const onceListeners = new Map(); // pattern -> Set(fn)

  /** @type {Array<object>} */
  const replayBuffer = []; // { id, name, payload, meta, at }

  /** @type {Set<object>} */
  const bridgesTo = new Set(); // objects with emit()
  /** @type {Set<Function>} */
  const bridgeOffs = new Set(); // unsubscribe functions for bridgeFrom()

  function ensureSet(map, key) {
    const k = normalizeName(key);
    if (!k) return null;
    if (!map.has(k)) map.set(k, new Set());
    return map.get(k);
  }

  function validateName(n) {
    const nn = normalizeName(n);
    if (!nn) {
      if (strict) throw new Error(`${name}: event name is required`);
      return null;
    }
    return nn;
  }

  function pushReplay(evt) {
    if (!replaySize) return;
    replayBuffer.push(evt);
    while (replayBuffer.length > replaySize) replayBuffer.shift();
  }

  function snapshotListenersFor(eventName) {
    const fns = [];

    // regular
    for (const [pattern, set] of listeners.entries()) {
      if (!set || set.size === 0) continue;
      if (matchPattern(pattern, eventName)) {
        for (const fn of set.values()) fns.push({ fn, once: false, pattern });
      }
    }

    // once
    for (const [pattern, set] of onceListeners.entries()) {
      if (!set || set.size === 0) continue;
      if (matchPattern(pattern, eventName)) {
        for (const fn of set.values()) fns.push({ fn, once: true, pattern });
      }
    }

    return fns;
  }

  function removeOnce(pattern, fn) {
    const set = onceListeners.get(normalizeName(pattern));
    if (!set) return;
    set.delete(fn);
    if (set.size === 0) onceListeners.delete(normalizeName(pattern));
  }

  async function dispatchOne(listener, evt) {
    try {
      const res = listener.fn(evt);
      // Allow async listeners
      if (res && typeof res.then === "function") {
        await res;
      }
    } catch (err) {
      // isolate listener errors
      try {
        // eslint-disable-next-line no-console
        console.warn(`${name}: listener error for "${evt.name}"`, err);
      } catch {
        // ignore
      }
    } finally {
      if (listener.once) removeOnce(listener.pattern, listener.fn);
    }
  }

  function emit(eventName, payload, meta = undefined) {
    const en = validateName(eventName);
    if (!en) return { ok: false, reason: "invalid_name" };

    const evt = {
      id: createId("evt"),
      name: en,
      payload,
      meta: isObj(meta) ? meta : meta != null ? { meta } : undefined,
      at: nowMs(),
      source: SOURCE,
      bus: name,
    };

    pushReplay(evt);

    const targets = snapshotListenersFor(en);

    // Bridge out to other busses (fire-and-forget)
    for (const b of bridgesTo.values()) {
      try {
        b?.emit?.(en, payload, {
          ...evt.meta,
          bridgedFrom: name,
          evtId: evt.id,
          at: evt.at,
        });
      } catch {
        // ignore
      }
    }

    if (!targets.length) return { ok: true, delivered: 0, evt };

    if (asyncDispatch) {
      // microtask queue
      Promise.resolve().then(async () => {
        for (const t of targets) await dispatchOne(t, evt);
      });
      return { ok: true, delivered: targets.length, evt, async: true };
    }

    // sync dispatch
    (async () => {
      for (const t of targets) await dispatchOne(t, evt);
    })();

    return { ok: true, delivered: targets.length, evt, async: false };
  }

  function on(pattern, fn, options = {}) {
    const p = normalizeName(pattern);
    const f = safeFn(fn);
    if (!p || !f) {
      if (strict) throw new Error(`${name}: on(pattern, fn) requires both`);
      return () => {};
    }

    const set = ensureSet(listeners, p);
    set.add(f);

    // Optional replay
    const replay = options?.replay === true || options?.replay === "all";
    if (replay && replayBuffer.length) {
      const matched = replayBuffer.filter((e) => matchPattern(p, e.name));
      if (matched.length) {
        const toSend = options?.replay === "all" ? matched : matched.slice(-1);
        Promise.resolve().then(async () => {
          for (const e of toSend)
            await dispatchOne({ fn: f, once: false, pattern: p }, e);
        });
      }
    }

    return () => off(p, f);
  }

  function once(pattern, fn, options = {}) {
    const p = normalizeName(pattern);
    const f = safeFn(fn);
    if (!p || !f) {
      if (strict) throw new Error(`${name}: once(pattern, fn) requires both`);
      return () => {};
    }
    const set = ensureSet(onceListeners, p);
    set.add(f);

    // Optional replay: if replay hits, we should fire immediately and remove
    const replay = options?.replay === true || options?.replay === "all";
    if (replay && replayBuffer.length) {
      const matched = replayBuffer.filter((e) => matchPattern(p, e.name));
      if (matched.length) {
        const e =
          options?.replay === "all"
            ? matched[matched.length - 1]
            : matched[matched.length - 1];
        Promise.resolve().then(async () => {
          await dispatchOne({ fn: f, once: true, pattern: p }, e);
        });
      }
    }

    return () => offOnce(p, f);
  }

  function off(pattern, fn) {
    const p = normalizeName(pattern);
    const f = safeFn(fn);
    if (!p) return;
    const set = listeners.get(p);
    if (!set) return;
    if (f) set.delete(f);
    else set.clear();
    if (set.size === 0) listeners.delete(p);
  }

  function offOnce(pattern, fn) {
    const p = normalizeName(pattern);
    const f = safeFn(fn);
    if (!p) return;
    const set = onceListeners.get(p);
    if (!set) return;
    if (f) set.delete(f);
    else set.clear();
    if (set.size === 0) onceListeners.delete(p);
  }

  function clear(pattern = null) {
    if (!pattern) {
      listeners.clear();
      onceListeners.clear();
      return;
    }
    off(pattern);
    offOnce(pattern);
  }

  function listenersCount() {
    let c = 0;
    for (const s of listeners.values()) c += s.size;
    for (const s of onceListeners.values()) c += s.size;
    return c;
  }

  function patterns() {
    const set = new Set([...listeners.keys(), ...onceListeners.keys()]);
    return Array.from(set.values()).sort();
  }

  function replay() {
    return replayBuffer.slice();
  }

  // Namespaces: bus.ns("session") => emits/listens with "session.*"
  function ns(prefix) {
    const p = normalizeName(prefix);
    const pre = p ? p + "." : "";
    return {
      emit: (name, payload, meta) =>
        emit(pre + normalizeName(name), payload, meta),
      on: (name, fn, options) => on(pre + normalizeName(name), fn, options),
      once: (name, fn, options) => once(pre + normalizeName(name), fn, options),
      off: (name, fn) => off(pre + normalizeName(name), fn),
      clear: (name) => clear(pre + normalizeName(name)),
    };
  }

  // Bridge helpers
  function bridgeTo(otherBus) {
    if (otherBus && typeof otherBus.emit === "function")
      bridgesTo.add(otherBus);
    return () => bridgesTo.delete(otherBus);
  }

  function bridgeFrom(otherBus, patternsList = ["**"]) {
    if (!otherBus || typeof otherBus.on !== "function") {
      if (strict)
        throw new Error(`${name}: bridgeFrom requires a bus with on()`);
      return () => {};
    }
    const pats = toArr(patternsList).map(normalizeName).filter(Boolean);
    const offs = [];

    for (const p of pats.length ? pats : ["**"]) {
      const offFn = otherBus.on(p, (evt) => {
        // evt might be (payload) if other bus is simple. We try to detect shape.
        if (
          evt &&
          typeof evt === "object" &&
          "name" in evt &&
          "payload" in evt
        ) {
          emit(evt.name, evt.payload, {
            ...(evt.meta || {}),
            bridgedFrom: otherBus.name || "unknown",
          });
        } else {
          // assume payload-only; emit under the pattern name is impossible, so use p as event name
          emit(p, evt, {
            bridgedFrom: otherBus.name || "unknown",
            payloadOnly: true,
          });
        }
      });
      offs.push(offFn);
      bridgeOffs.add(offFn);
    }

    return () => {
      offs.forEach((f) => {
        try {
          f?.();
        } catch {
          // ignore
        }
        bridgeOffs.delete(f);
      });
    };
  }

  function destroy() {
    clear();
    for (const offFn of bridgeOffs.values()) {
      try {
        offFn?.();
      } catch {
        // ignore
      }
    }
    bridgeOffs.clear();
    bridgesTo.clear();
    replayBuffer.length = 0;
  }

  return {
    name,
    emit,
    on,
    once,
    off,
    offOnce,
    clear,
    destroy,
    listenersCount,
    patterns,
    replay,
    ns,
    bridgeTo,
    bridgeFrom,
  };
}

/* -----------------------------------------------------------------------------
 * Default singleton (recommended)
 * -------------------------------------------------------------------------- */

const automationBus = createEventBus({
  name: "automationBus",
  replaySize: 50, // helpful for debugging; keep small
  async: true,
  strict: false,
});

export default automationBus;
