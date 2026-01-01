// C:\Users\larho\suka-smart-assistant\src\connectors\FamilyFundConnector.js
// -----------------------------------------------------------------------------
// Suka Smart Assistant – Family Fund Connector
// -----------------------------------------------------------------------------
// PURPOSE
// This file activates **SSA → Hub** data export.
//
// SSA is the system-of-record for the household.
// The Suka Village Family Fund Hub (SVFFH) is an *optional* upstream that can
// receive household events (imports parsed, inventory updated, storehouse low,
// garden harvest logged, preservation completed, commerce signals, etc.).
//
// This connector is the thin, defensive bridge used by other files like:
//   - src/knowledge/KnowledgeGraph.js
//   - src/commerce/CommerceTriggerEngine.js
//   - src/commerce/BarterSuggestion.js
//   - src/analytics/*.js
//   - src/import/shareCaptureHandler.js
//
// Design rules:
// 1. **Do not block SSA** – export must fail silently.
// 2. **Feature-flag aware** – only send if familyFundMode=true.
// 3. **Consistent payload** – wrap as { ts, source, data } if needed.
// 4. **Event-driven** – emit “hub.export.success” / “hub.export.failed” so the
//    UI / analytics / automation runtime can react.
// 5. **Forward-thinking** – support HTTP POST today, WebSocket later, offline
//    queue for PWA, and multiple hub instances in the future.
//
// -----------------------------------------------------------------------------
// ASSUMPTIONS
// - There is a central featureFlags bridge at "../config/index.js"
// - There is an eventBus at "../services/events/eventBus.js"
// - The hub URL can be configured via:
//     window.__suka?.hub?.endpoint
//     config.getConfig().hub.apiBase
//     process.env.SUKA_HUB_ENDPOINT
//     featureFlags.hubEndpoint (legacy)
// - Running in browser or node (we guard window).
// -----------------------------------------------------------------------------

import config, { featureFlags } from "../config/index.js";

// Be tolerant to either a *named* or *default* export from eventBus.js
import eventBusDefault, { eventBus as namedEventBus } from "../services/events/eventBus.js";
const eventBus = namedEventBus ?? eventBusDefault;

const isBrowser = typeof window !== "undefined";

// fallback endpoint – SAFE default (no-op server)
// you should override this in your app bootstrap / env
const DEFAULT_HUB_ENDPOINT = "https://hub.suka.local/api/ingest";

// simple in-memory offline queue (optional persist in browser)
const offlineQueue = [];

// -----------------------------------------------------------------------------
// helpers
// -----------------------------------------------------------------------------
function nowIso() {
  return new Date().toISOString();
}

function getHubEndpoint() {
  // priority: window config → config.getConfig().hub.apiBase → feature flags (legacy) → env → default
  if (isBrowser && window.__suka?.hub?.endpoint) {
    return window.__suka.hub.endpoint;
  }
  try {
    const cfg = config?.getConfig?.();
    if (cfg?.hub?.apiBase) return cfg.hub.apiBase;
  } catch {
    // ignore – continue fallbacks
  }
  if (featureFlags?.hubEndpoint) {
    return featureFlags.hubEndpoint;
  }
  if (typeof process !== "undefined" && process.env?.SUKA_HUB_ENDPOINT) {
    return process.env.SUKA_HUB_ENDPOINT;
  }
  return DEFAULT_HUB_ENDPOINT;
}

function emitHubEvent(type, data = {}) {
  const evt = { type, ts: nowIso(), source: "family-fund-connector", data };
  try {
    eventBus?.emit?.(evt);
  } catch (_) {
    // never hard-crash exports
  }
  return evt;
}

// try to persist queue in localStorage for PWA/offline
function persistQueue() {
  if (!isBrowser) return;
  try {
    window.localStorage.setItem(
      "suka.hub.offlineQueue.v1",
      JSON.stringify(offlineQueue.slice(-200)), // cap
    );
  } catch (_) {
    // best effort
  }
}

function loadQueue() {
  if (!isBrowser) return;
  try {
    const raw = window.localStorage.getItem("suka.hub.offlineQueue.v1");
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        offlineQueue.push(...arr);
      }
    }
  } catch (_) {
    // ignore
  }
}

// -----------------------------------------------------------------------------
// main connector
// -----------------------------------------------------------------------------
class FamilyFundConnector {
  constructor() {
    this.endpoint = getHubEndpoint();
    this.ws = null;
    this.wsReady = false;
    this.initialized = false;
  }

  init() {
    if (this.initialized) return;
    this.initialized = true;

    // load offline queue on startup (browser only)
    loadQueue();

    // try to bootstrap websocket (optional)
    this.tryInitWebSocket();

    // optionally, listen to "hub.export.request" in case other modules broadcast
    const bus = eventBus || (isBrowser ? window.__suka?.eventBus : null);
    if (bus?.on) {
      bus.on?.((evt) => {
        if (evt?.type === "hub.export.request" && evt.data) {
          this.send(evt.data, { reason: "bus" });
        }
      });
    }

    // on regain online, flush
    if (isBrowser) {
      window.addEventListener("online", () => {
        this.flushOffline().catch(() => {});
      });
    }
  }

  isEnabled() {
    return !!featureFlags?.familyFundMode;
  }

  isAvailable() {
    // If feature is off, we call it "not available".
    if (!this.isEnabled()) return false;
    // If ws is ready, it's available.
    if (this.wsReady) return true;
    // HTTP might still work even if WS is not ready
    return !!this.endpoint;
  }

  tryInitWebSocket() {
    if (!isBrowser) return;
    if (!this.isEnabled()) return;
    const base = this.endpoint || DEFAULT_HUB_ENDPOINT;
    // quick transform: https://host/api/ingest → wss://host/ws
    const wsUrl = base.replace(/^http/i, "ws").replace(/\/api\/ingest.*$/, "/ws");

    try {
      const ws = new WebSocket(wsUrl);
      this.ws = ws;

      ws.onopen = () => {
        this.wsReady = true;
        emitHubEvent("hub.ws.opened", { url: wsUrl });
        this.flushOffline().catch(() => {});
      };
      ws.onclose = () => {
        this.wsReady = false;
        emitHubEvent("hub.ws.closed", { url: wsUrl });
      };
      ws.onerror = (err) => {
        this.wsReady = false;
        emitHubEvent("hub.ws.error", { message: err?.message || "ws error" });
      };
      ws.onmessage = (e) => {
        emitHubEvent("hub.ws.message", { payload: e.data });
      };
    } catch (_) {
      // swallow – we can work over HTTP
    }
  }

  /**
   * Send a payload to the Hub.
   * `payload` should be either:
   *  - already formatted (with kind, at, etc.)
   *  - or raw SSA event, we'll wrap it
   */
  async send(payload, { reason = "direct" } = {}) {
    // if hub mode off → just noop
    if (!this.isEnabled()) {
      emitHubEvent("hub.export.skipped", {
        reason: "familyFundMode.disabled",
        original: payload,
      });
      return;
    }

    const normalized = this._normalizePayload(payload, reason);

    // 1) try WS first
    if (this.ws && this.wsReady) {
      try {
        this.ws.send(JSON.stringify(normalized));
        emitHubEvent("hub.export.success", {
          transport: "ws",
          payload: normalized,
        });
        return;
      } catch (_) {
        // fall back to HTTP
      }
    }

    // 2) fallback to HTTP POST
    try {
      const endpoint = this.endpoint || getHubEndpoint();
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(normalized),
      });

      if (!res.ok) {
        // if server is down → queue
        this._queueOffline(normalized);
        emitHubEvent("hub.export.failed", {
          transport: "http",
          status: res.status,
          payload: normalized,
        });
        return;
      }

      emitHubEvent("hub.export.success", {
        transport: "http",
        payload: normalized,
      });
    } catch (err) {
      // network down → queue for later
      this._queueOffline(normalized);
      emitHubEvent("hub.export.failed", {
        transport: "http",
        error: err?.message,
        payload: normalized,
      });
    }
  }

  _normalizePayload(payload, reason = "direct") {
    // already formatted?
    if (payload && payload.kind) {
      return {
        ...payload,
        ts: payload.ts || nowIso(),
        source: payload.source || "ssa",
        meta: {
          ...(payload.meta || {}),
          via: "FamilyFundConnector",
          reason,
        },
      };
    }

    // wrap raw payload
    return {
      kind: "ssa.event",
      ts: nowIso(),
      source: "ssa",
      data: payload,
      meta: {
        via: "FamilyFundConnector",
        reason,
      },
    };
  }

  _queueOffline(payload) {
    offlineQueue.push(payload);
    persistQueue();
  }

  async flushOffline() {
    if (!this.isEnabled()) return;
    if (!offlineQueue.length) return;

    const toSend = offlineQueue.splice(0, offlineQueue.length);
    for (const item of toSend) {
      // best effort; don't recurse queue on failure to avoid infinite loop
      try {
        // eslint-disable-next-line no-await-in-loop
        await this.send(item, { reason: "flush-offline" });
      } catch (_) {
        // swallow; it'll requeue in send()
      }
    }
  }
}

// singleton
const familyFundConnector = new FamilyFundConnector();
familyFundConnector.init();

export default familyFundConnector;
export { FamilyFundConnector };
