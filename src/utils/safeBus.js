/* eslint-disable no-console */
// utils/safeBus.js — resilient, browser+SSR friendly event bus wrapper for Suka

const isBrowser = typeof window !== "undefined";
const DEBUG = (() => {
  try {
    return (localStorage.getItem("suka:debug:bus") || "") === "1";
  } catch {
    return false;
  }
})();

// ----------------------------- Internal state ------------------------------
let externalBus = null; // your real eventBus if available
let ready = false;
let queuedEmits = []; // [{ evt, payload }]
let queuedSubs = []; // [{ evt, handler, opts }]
let wildcardSubs = []; // same shape, for patterns containing '*'
let crossTab = { enabled: false, bc: null, filter: null }; // BroadcastChannel relay

// Try to load external bus defensively (works with CJS/ESM and named/default exports)
(function tryLoadExternal() {
  try {
    // eslint-disable-next-line global-require
    const mod = require("@/services/events/eventBus");
    const eb = (mod && (mod.default || mod.eventBus || mod)) || null;
    if (eb) setExternalBus(eb);
  } catch (_e) {
    // noop: we’ll operate in queued mode until someone calls setExternalBus()
  }
})();

// ------------------------------ Utilities ----------------------------------
function log(...args) {
  if (DEBUG) console.log("[safeBus]", ...args);
}

function matchPattern(pattern, event) {
  // Supports "a.b.*", "*.refresh", "*" (match all)
  if (pattern === "*" || !pattern) return true;
  const p = String(pattern).split(".");
  const e = String(event).split(".");
  for (let i = 0; i < Math.max(p.length, e.length); i++) {
    const segP = p[i],
      segE = e[i];
    if (segP === "*") continue;
    if (segP !== segE) return false;
  }
  return true;
}

function ensureBroadcastChannel() {
  if (!isBrowser) return null;
  if (!("BroadcastChannel" in window)) return null;
  if (!crossTab.bc) crossTab.bc = new BroadcastChannel("suka-safe-bus");
  return crossTab.bc;
}

// ------------------------------ Core facade --------------------------------
export function setExternalBus(bus) {
  // Allow late binding when your real eventBus becomes available
  if (bus && typeof bus.emit === "function") {
    externalBus = bus;
    ready = true;
    log("external bus attached, flushing queues…");

    // Re-register queued subscriptions on the real bus
    queuedSubs.forEach(({ evt, handler, opts }) => {
      try {
        externalBus.on?.(evt, handler, opts);
      } catch {}
    });
    // Wire wildcard listeners via our adapter layer (we’ll keep them in wildcardSubs)
    // Emit queued messages
    queuedEmits.forEach(({ evt, payload }) => {
      try {
        externalBus.emit?.(evt, payload);
      } catch {}
    });
    queuedSubs = [];
    queuedEmits = [];
  }
}

export function getBus() {
  // Returns a tiny adapter that always has on/off/emit
  return {
    on: (evt, handler, opts) => on(evt, handler, opts),
    off: (evt, handler) => off(evt, handler),
    emit: (evt, payload) => emit(evt, payload),
  };
}

export function emit(event, payload) {
  try {
    if (crossTab.enabled) {
      const bc = ensureBroadcastChannel();
      if (
        bc &&
        (!crossTab.filter || crossTab.filter(event, payload) !== false)
      ) {
        bc.postMessage({ event, payload, ts: Date.now() });
      }
    }
  } catch {}

  if (!ready || !externalBus) {
    queuedEmits.push({ evt: event, payload });
    log("queued emit", event, payload);
    return;
  }

  try {
    externalBus.emit?.(event, payload);
    // Fan-out to wildcard listeners (they're managed by safeBus)
    wildcardSubs.forEach(({ evt: pattern, handler }) => {
      try {
        if (matchPattern(pattern, event)) handler(payload, event);
      } catch {}
    });
  } catch (e) {
    if (DEBUG) console.warn("[safeBus] emit failed", event, e);
  }
}

export function on(event, handler, opts = {}) {
  // Wildcard subscriptions are handled by safeBus (so they work even if your bus doesn't support them)
  const isWildcard = String(event).includes("*");
  const sub = { evt: event, handler, opts };

  if (isWildcard) {
    wildcardSubs.push(sub);
    log("wildcard on", event);
    // If the external bus supports a global tap, you could hook once; otherwise we fan-out on emit()
    return () => off(event, handler);
  }

  if (!ready || !externalBus) {
    queuedSubs.push(sub);
    log("queued on", event);
    return () => {
      // Remove from queue if still queued
      queuedSubs = queuedSubs.filter(
        (s) => !(s.evt === event && s.handler === handler)
      );
    };
  }

  let unsubscribe = () => {};
  try {
    const ret = externalBus.on?.(event, handler, opts);
    // Some buses return a disposer; others require explicit .off
    if (typeof ret === "function") unsubscribe = ret;
    else
      unsubscribe = () => {
        try {
          externalBus.off?.(event, handler);
        } catch {}
      };
  } catch {
    // fall back to no-op
  }
  return unsubscribe;
}

export function off(event, handler) {
  // Remove wildcard
  wildcardSubs = wildcardSubs.filter(
    (s) => !(s.evt === event && s.handler === handler)
  );

  if (!ready || !externalBus) {
    // Remove from queued subscriptions
    queuedSubs = queuedSubs.filter(
      (s) => !(s.evt === event && s.handler === handler)
    );
    return;
  }
  try {
    externalBus.off?.(event, handler);
  } catch {}
}

// One-shot listener
export function once(event, handler, opts) {
  const wrap = (payload, evtName) => {
    try {
      handler(payload, evtName);
    } finally {
      un();
    }
  };
  const un = on(event, wrap, opts);
  return un;
}

// Promise that resolves when an event arrives (optionally gated by predicate/timeout)
export function waitFor(event, predicate = null, { timeoutMs = 0 } = {}) {
  return new Promise((resolve, reject) => {
    let done = false;
    const un = on(event, (payload, evtName) => {
      if (done) return;
      if (predicate && !predicate(payload, evtName)) return;
      done = true;
      un();
      resolve({ event: evtName, payload });
    });
    let t;
    if (timeoutMs > 0) {
      t = setTimeout(() => {
        if (done) return;
        done = true;
        un();
        reject(new Error("waitFor timeout"));
      }, timeoutMs);
    }
  });
}

// Namespaced helper (e.g., const bus = scoped("calendar"); bus.emit("refresh"))
export function scoped(ns) {
  const prefix = String(ns || "").trim();
  const join = (evt) => (prefix ? `${prefix}.${evt}` : evt);
  return {
    emit: (evt, payload) => emit(join(evt), payload),
    on: (evt, handler, opts) => on(join(evt), handler, opts),
    off: (evt, handler) => off(join(evt), handler),
    once: (evt, handler, opts) => once(join(evt), handler, opts),
    waitFor: (evt, pred, o) => waitFor(join(evt), pred, o),
  };
}

// Enable or disable cross-tab event relay via BroadcastChannel
export function enableCrossTabRelay({ enabled = true, filter = null } = {}) {
  crossTab.enabled = !!enabled;
  crossTab.filter = typeof filter === "function" ? filter : null;

  if (!enabled && crossTab.bc) {
    try {
      crossTab.bc.close();
    } catch {}
    crossTab.bc = null;
    return;
  }
  const bc = ensureBroadcastChannel();
  if (!bc) return;
  bc.onmessage = (ev) => {
    const { event, payload } = ev.data || {};
    // Avoid echo loops: we just forward to local listeners; no re-broadcast
    wildcardSubs.forEach(({ evt: pattern, handler }) => {
      try {
        if (matchPattern(pattern, event)) handler(payload, event);
      } catch {}
    });
    if (ready && externalBus) {
      try {
        externalBus.emit?.(event, payload);
      } catch {}
    } else {
      // if bus not ready, queue it
      queuedEmits.push({ evt: event, payload });
    }
  };
}

// ------------------------------ React helper --------------------------------
// Minimal hook for ergonomics: useBus("calendar.refresh", cb)
export function useBus(event, handler, deps = []) {
  // Lazy require to avoid hard React dep in non-React contexts
  let ReactRef;
  try {
    ReactRef = require("react");
  } catch {
    ReactRef = null;
  }

  if (!ReactRef) {
    // Non-React runtime: register once immediately (best effort)
    return on(event, handler);
  }

  const { useEffect } = ReactRef;
  useEffect(() => {
    const un = on(event, handler);
    return () => un?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

// ---------------------- Orchestration convenience emitters ------------------
// These helpers keep usage clean across the app and standardize payload shapes.

// Open the Save Favorite Plan modal (house ads, badges, etc. call this)
export function openSaveFavoriteModal(suggested = {}) {
  emit("plan.save.modal.open", {
    source: suggested.source || "Unknown",
    suggested: {
      planId: suggested.planId || `fav:${Date.now()}`,
      title: suggested.title || "My Favorite Plan",
      domain: suggested.domain || "meals",
      tags: suggested.tags || ["evergreen"],
      ...suggested,
    },
    tsISO: new Date().toISOString(),
  });
}

// Fire a plan.saved semantic event (call after persistence succeeds)
export function notifyPlanSaved(meta) {
  emit("plan.saved", {
    planId: meta?.planId,
    domain: meta?.domain,
    title: meta?.title,
    target: meta?.target || "local",
    source: meta?.source || "unknown",
    tsISO: new Date().toISOString(),
  });
}

// Generic toasts
export function toast(kind = "info", message = "", meta = {}) {
  emit("toast", { kind, message, ...meta, tsISO: new Date().toISOString() });
}

// ------------------------------ CJS interop ---------------------------------
const api = {
  setExternalBus,
  getBus,
  emit,
  on,
  off,
  once,
  waitFor,
  scoped,
  enableCrossTabRelay,
  useBus,
  openSaveFavoriteModal,
  notifyPlanSaved,
  toast,
};

export default api;

if (typeof module !== "undefined" && module.exports) {
  module.exports = api;
}
