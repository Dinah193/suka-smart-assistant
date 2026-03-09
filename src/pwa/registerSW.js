// src/pwa/registerSW.js
// Guarded Service Worker registration helper for SSA.
//
// How this fits the SSA pipeline:
// imports → intelligence → automation → (optional) hub export
// • This file does not mutate household data. It boots the PWA layer that makes the
//   "play" surfaces resilient (offline caching + background log delivery).
// • It wires SW <-> App messaging and emits SSA-standard envelopes via eventBus.
//
// Use from App.jsx/main.jsx:
//   import { registerSW } from "@/pwa/registerSW";
//   const sw = registerSW({ swUrl: "/service-worker.js", scope: "/", autoUpdate: true });
//
//   // Optional: interact later
//   sw.flushPlayLogs();
//   sw.queuePlayLog({ type: "play.timer.tick", data: {...} });
//   sw.checkForUpdates();

let eventBus = {
  emit: (...a) => console.debug("[registerSW:eventBus.emit]", ...a),
};
try {
  const eb = require("@/services/events/eventBus");
  eventBus = eb?.default || eb?.eventBus || eventBus;
} catch {
  /* optional */
}

const SRC = "pwa.registerSW";

function nowIso() {
  return new Date().toISOString();
}
function envelope(type, data = {}) {
  return { type, ts: nowIso(), source: SRC, data };
}
function emit(type, data) {
  try {
    eventBus.emit(envelope(type, data));
  } catch (err) {
    // non-fatal; still useful in apps without eventBus wired
    console.warn("[registerSW] eventBus.emit failed", err);
  }
}

function isLocalhost() {
  try {
    const h = self?.location?.hostname || window.location.hostname;
    return h === "localhost" || h === "127.0.0.1" || h === "[::1]";
  } catch {
    return false;
  }
}

function isSupported() {
  try {
    const httpsLike = window.isSecureContext || isLocalhost();
    return "serviceWorker" in navigator && httpsLike;
  } catch {
    return false;
  }
}

/**
 * Register the Service Worker with guards and lifecycle management.
 *
 * @param {Object} opts
 * @param {string} [opts.swUrl]     URL of the SW file (default tries "/service-worker.js", then "/src/pwa/service-worker.js")
 * @param {string} [opts.scope]     Registration scope (default "/")
 * @param {boolean} [opts.autoUpdate]  If true, auto-activate waiting SW and reload on controllerchange
 * @param {boolean} [opts.silent]   Suppress console output (eventBus still emits)
 * @param {(reg: ServiceWorkerRegistration)=>void} [opts.onReady] callback when ready
 * @returns {Object} tiny API { ready, registration, checkForUpdates, message, flushPlayLogs, queuePlayLog, unregister, getRegistration }
 */
function registerSW(opts = {}) {
  const {
    swUrl: inputUrl,
    scope = "/",
    autoUpdate = true,
    silent = false,
    onReady,
  } = opts;

  if (!isSupported()) {
    !silent &&
      console.info(
        "[registerSW] SW not supported or insecure context; skipping"
      );
    emit("sw.register.skip", { reason: "unsupported" });
    return apiNoop();
  }

  const swUrl = resolveSwUrl(inputUrl);
  if (!swUrl) {
    !silent &&
      console.warn("[registerSW] No service worker URL resolved; skipping");
    emit("sw.register.skip", { reason: "no-url" });
    return apiNoop();
  }

  emit("sw.register.start", { swUrl, scope });

  // Registration promise (exposed as .ready)
  const ready = navigator.serviceWorker
    .register(swUrl, { scope })
    .then((registration) => {
      wireLifecycle(registration, { autoUpdate, silent });
      wireMessages({ silent });
      if (typeof onReady === "function") {
        try {
          onReady(registration);
        } catch {}
      }
      emit("sw.register.success", { scope, url: swUrl });
      return registration;
    })
    .catch((err) => {
      !silent && console.error("[registerSW] registration failed:", err);
      emit("sw.register.error", { message: err?.message || String(err) });
      return null;
    });

  // Public API
  const api = {
    ready,
    getRegistration: async () =>
      (await ready) || navigator.serviceWorker.getRegistration(scope),
    registration: null, // will be set when ready resolves
    async checkForUpdates() {
      const reg = await api.getRegistration();
      if (!reg) return false;
      try {
        // Try both update() and skipWaiting protocol
        await reg.update();
        emit("sw.update.check", { ok: true });
        return true;
      } catch (err) {
        emit("sw.update.check", {
          ok: false,
          message: err?.message || String(err),
        });
        return false;
      }
    },
    async message(cmd, payload = {}) {
      const controller = navigator.serviceWorker.controller;
      if (!controller) return false;
      try {
        controller.postMessage({ cmd, ...payload });
        return true;
      } catch {
        return false;
      }
    },
    async flushPlayLogs() {
      // Prefer Background Sync route; fallback to direct message
      return api.message("flushPlayLogs");
    },
    async queuePlayLog(body, headers) {
      return api.message("queuePlayLog", { body, headers });
    },
    async unregister() {
      const reg = await api.getRegistration();
      if (!reg) return false;
      try {
        await reg.unregister();
        emit("sw.unregister", { ok: true });
        return true;
      } catch (err) {
        emit("sw.unregister", {
          ok: false,
          message: err?.message || String(err),
        });
        return false;
      }
    },
  };

  // stash registration on resolution
  ready.then((reg) => {
    api.registration = reg;
  });

  return api;
}

/* ------------------------------- Internals ------------------------------- */

function resolveSwUrl(inputUrl) {
  if (typeof inputUrl === "string" && inputUrl.trim()) return inputUrl;
  // Prefer root-level build artifact; fallback to source path for dev
  const candidates = ["/service-worker.js", "/src/pwa/service-worker.js"];
  for (const c of candidates) {
    // We can't statically check; return first candidate. The SW file itself will be fetched by the browser.
    return c;
  }
  return null;
}

function wireLifecycle(registration, { autoUpdate, silent }) {
  try {
    // Update found (installing new worker)
    registration.addEventListener?.("updatefound", () => {
      const sw = registration.installing;
      if (!sw) return;
      sw.addEventListener("statechange", () => {
        !silent && console.info("[registerSW] state:", sw.state);
        emit("sw.state", { state: sw.state });
        if (sw.state === "installed") {
          if (navigator.serviceWorker.controller) {
            // New update available
            emit("sw.update.available", {});
            if (autoUpdate && registration.waiting) {
              // Ask the waiting SW to skip waiting so it becomes active
              try {
                registration.waiting.postMessage({ cmd: "SKIP_WAITING" });
              } catch {}
            }
          } else {
            // First install
            emit("sw.install.ready", {});
          }
        }
      });
    });

    // When a new SW takes control
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      emit("sw.controller.changed", {});
      if (autoUpdate) {
        // Give the app a beat to save UI state if needed
        setTimeout(() => {
          try {
            window.location.reload();
          } catch {}
        }, 100);
      }
    });
  } catch (err) {
    !silent && console.warn("[registerSW] wireLifecycle failed", err);
  }
}

function wireMessages({ silent }) {
  try {
    navigator.serviceWorker.addEventListener("message", (event) => {
      const msg = event?.data || {};
      // Expect SSA-style envelopes from the SW
      if (msg && typeof msg === "object" && msg.type && msg.ts) {
        emit("sw.message", { inbound: true, msg });
      } else {
        emit("sw.message.legacy", { inbound: true, raw: msg });
      }

      // Optional: mirror selected SW events to console for dev readability
      if (!silent && msg && msg.type && /^sw\./.test(msg.type)) {
        console.info("[SW]", msg.type, msg.data || "");
      }
    });
  } catch (err) {
    !silent && console.warn("[registerSW] wireMessages failed", err);
  }
}

function apiNoop() {
  const noop = async () => false;
  return {
    ready: Promise.resolve(null),
    getRegistration: async () => null,
    registration: null,
    checkForUpdates: noop,
    message: noop,
    flushPlayLogs: noop,
    queuePlayLog: noop,
    unregister: noop,
  };
}

/* --------------------------------- Exports -------------------------------- */

module.exports = {
  registerSW,
  __internals: {
    isSupported,
    isLocalhost,
    resolveSwUrl,
    wireLifecycle,
    wireMessages,
    envelope,
    emit,
  },
};
