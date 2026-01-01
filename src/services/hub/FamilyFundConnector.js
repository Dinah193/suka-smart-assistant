// C:\Users\larho\suka-smart-assistant\src\services\hub\FamilyFundConnector.js
// -----------------------------------------------------------------------------
// PURPOSE (Shim-friendly Hub connector)
// -----------------------------------------------------------------------------
// This module is a *transport shim* between SSA and the Suka Village Family Fund
// Hub. It does NOT know about React, SessionRunner UI, or Dexie directly.
//
// Responsibilities:
//   • Accept *Hub-ready packets* (e.g. from HubPacketFormatter.formatSessionDelta)
//   • Respect feature flags: familyFundMode + hubExport.*
//   • Queue packets when offline / Hub unreachable (optional)
//   • Flush queue when network is available
//   • Be safe to use from:
//        - SessionRunner shims
//        - Agents / agent-shims
//        - Background workers
//
// Important:
//   • This file does NOT build packets itself. Use HubPacketFormatter for that.
//   • This file does NOT read featureFlags.json directly; instead, it exposes a
//     `configureHubConnector` function so the app can inject flags + endpoint.
//   • It is safe to import anywhere in SSA. All browser APIs are guarded.
//
// Typical wiring (e.g. in App root or a bootstrap file):
//
//   import {
//     configureHubConnector,
//     exportToHubIfEnabled,
//     FamilyFundConnector,
//   } from "@/services/hub/FamilyFundConnector";
//   import featureFlags from "@/services/featureFlags"; // or similar
//
//   configureHubConnector({
//     familyFundMode: featureFlags.familyFundMode,
//     hubExport: featureFlags.hubExport,
//     endpoint: "/hub/api/events",
//     getAuthToken: () => localStorage.getItem("hubToken"),
//     environment: import.meta.env.MODE,
//   });
//
//   // From SessionRunner shim when a delta is ready:
//   if (featureFlags.familyFundMode) {
//     const packet = formatSessionDelta({ eventEnvelope, previousSession, currentSession, context });
//     exportToHubIfEnabled(packet, { mode: "auto" });
//   }
//
// -----------------------------------------------------------------------------

/**
 * @typedef {Object} HubExportConfig
 * @property {boolean} [enabled]
 * @property {boolean} [onDataChange]
 * @property {boolean} [queueIfOffline]
 */

/**
 * @typedef {Object} HubConnectorConfig
 * @property {boolean} [familyFundMode]          // master gate for Hub usage
 * @property {HubExportConfig} [hubExport]       // mirrors featureFlags.defaults.hubExport
 * @property {string} [endpoint]                 // Hub HTTP endpoint
 * @property {() => (string|null|undefined)} [getAuthToken]  // optional auth token provider
 * @property {string} [environment]              // "development" | "staging" | "production" | etc.
 */

/**
 * @typedef {Object} HubQueuedItem
 * @property {string} id
 * @property {number} enqueuedAt
 * @property {number} attempts
 * @property {any}    packet
 * @property {string|null} lastError
 */

const DEFAULT_ENDPOINT = "/hub/api/events";
const STORAGE_KEY = "suka.hub.queue.v1";
const MAX_ATTEMPTS = 5;
const FLUSH_BACKOFF_MS = 15000;

// -----------------------------------------------------------------------------
// Internal mutable state (kept minimal for shim usage)
// -----------------------------------------------------------------------------

/** @type {HubConnectorConfig} */
let _config = {
  familyFundMode: false,
  hubExport: {
    enabled: true,
    onDataChange: true,
    queueIfOffline: true,
  },
  endpoint: DEFAULT_ENDPOINT,
  getAuthToken: undefined,
  environment: "production",
};

/** @type {HubQueuedItem[]} */
let _queue = [];

let _isFlushing = false;
let _lastFlushAttempt = 0;

// Attach network listeners lazily (browser only)
if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("online", () => {
    // Soft schedule a flush after coming online
    tryFlushSoon("online");
  });
}

// -----------------------------------------------------------------------------
// Public configuration API
// -----------------------------------------------------------------------------

/**
 * Configure the Hub connector at runtime. Call this once at bootstrap,
 * then again whenever feature flags change (if needed).
 *
 * @param {Partial<HubConnectorConfig>} cfg
 */
export function configureHubConnector(cfg = {}) {
  if (!cfg || typeof cfg !== "object") return;
  _config = {
    ..._config,
    ...cfg,
    hubExport: {
      ..._config.hubExport,
      ...(cfg.hubExport || {}),
    },
  };

  // Try to hydrate queue from storage on first configure
  hydrateQueueFromStorage();
}

/**
 * Returns a shallow snapshot of current Hub configuration.
 * @returns {HubConnectorConfig}
 */
export function getHubConnectorConfig() {
  return { ..._config, hubExport: { ...(_config.hubExport || {}) } };
}

// -----------------------------------------------------------------------------
// Export helper (main entry point used by SessionRunner & agents)
// -----------------------------------------------------------------------------

/**
 * Main helper used by higher-level code.
 *
 * If Hub export is disabled or familyFundMode is false, this is a no-op.
 * Depending on mode:
 *   • mode === "immediate" → try sending right away; fallback to queue if needed.
 *   • mode === "queue"     → always queue (even if online).
 *   • mode === "auto"      → send if online, else queue.
 *
 * @param {any} packet                - Hub-ready packet (e.g. from HubPacketFormatter)
 * @param {{ mode?: "auto"|"immediate"|"queue", reason?: string }} [opts]
 */
export function exportToHubIfEnabled(packet, opts = {}) {
  if (!packet) return;
  if (!isHubExportEnabled()) return;

  const mode = opts.mode || "auto";

  if (mode === "queue") {
    enqueuePacket(packet, opts.reason || "queue-mode");
    return;
  }

  if (mode === "immediate") {
    sendNowOrQueue(packet, opts.reason || "immediate");
    return;
  }

  // auto
  sendNowOrQueue(packet, opts.reason || "auto");
}

// -----------------------------------------------------------------------------
// Core queue + flush logic
// -----------------------------------------------------------------------------

/**
 * Enqueue a packet and persist queue where possible.
 * @param {any} packet
 * @param {string} [reason]
 */
function enqueuePacket(packet, reason = "unknown") {
  const item = /** @type {HubQueuedItem} */ ({
    id: genId(),
    enqueuedAt: Date.now(),
    attempts: 0,
    packet,
    lastError: null,
  });

  _queue.push(item);
  persistQueueToStorage();

  if (_config.environment === "development") {
    // eslint-disable-next-line no-console
    console.debug("[FamilyFundConnector] queued packet", { reason, id: item.id });
  }

  // Optionally try a flush right away, in case we *are* online
  tryFlushSoon("enqueue");
}

/**
 * Try to send immediately; if offline or fails, queue instead.
 * @param {any} packet
 * @param {string} reason
 */
function sendNowOrQueue(packet, reason) {
  if (!isOnline() && (_config.hubExport?.queueIfOffline ?? true)) {
    enqueuePacket(packet, `${reason}:offline`);
    return;
  }

  // Push to queue then flush so we have unified logic for retries/backoff.
  enqueuePacket(packet, `${reason}:sendNow`);
  void tryFlushQueue("sendNow");
}

/**
 * Manually trigger a flush (e.g. on a settings screen button).
 * @returns {Promise<void>}
 */
export async function flushHubQueue() {
  await tryFlushQueue("manual");
}

/**
 * Internal orchestrator to avoid overlapping flushes and respect backoff.
 * @param {"manual"|"sendNow"|"enqueue"|"online"} origin
 * @returns {Promise<void>}
 */
async function tryFlushQueue(origin) {
  if (!isHubExportEnabled()) return;
  if (_isFlushing) return;
  if (!isOnline() && (_config.hubExport?.queueIfOffline ?? true)) return;

  const now = Date.now();
  if (now - _lastFlushAttempt < FLUSH_BACKOFF_MS && origin !== "manual") {
    // Too soon since last auto flush; skip to avoid hammering Hub.
    return;
  }

  _lastFlushAttempt = now;
  _isFlushing = true;

  try {
    while (_queue.length > 0 && isHubExportEnabled() && isOnline()) {
      const item = _queue[0];
      if (!item) break;

      const ok = await sendPacketToHub(item);
      if (ok) {
        _queue.shift();
        persistQueueToStorage();
      } else {
        // If send failed, decide whether to keep or drop based on attempts.
        if (item.attempts >= MAX_ATTEMPTS) {
          _queue.shift();
          persistQueueToStorage();
          if (_config.environment === "development") {
            // eslint-disable-next-line no-console
            console.warn("[FamilyFundConnector] dropping packet after max attempts", {
              id: item.id,
              lastError: item.lastError,
            });
          }
        } else {
          // Break out to respect backoff; we'll retry on next flush.
          break;
        }
      }
    }
  } finally {
    _isFlushing = false;
  }
}

/**
 * Schedule a flush "soon", used for online/enqueue hooks.
 * @param {"enqueue"|"online"} origin
 */
function tryFlushSoon(origin) {
  // Light wrapper to avoid multiple setTimeouts: just call tryFlushQueue,
  // which already handles overlapping and backoff.
  setTimeout(() => {
    void tryFlushQueue(origin);
  }, 250);
}

/**
 * Low-level HTTP send for a single queued item.
 * @param {HubQueuedItem} item
 * @returns {Promise<boolean>}  - true if Hub accepted, false otherwise
 */
async function sendPacketToHub(item) {
  const endpoint = _config.endpoint || DEFAULT_ENDPOINT;

  // Allow this shim to be usable in Node/Workers where `fetch` may not exist.
  if (typeof fetch !== "function") {
    item.attempts += 1;
    item.lastError = "fetch-not-available";
    return false;
  }

  /** @type {Record<string,string>} */
  const headers = {
    "Content-Type": "application/json",
  };

  try {
    const token = _config.getAuthToken ? _config.getAuthToken() : null;
    if (token) headers.Authorization = `Bearer ${token}`;
  } catch {
    // ignore token errors
  }

  item.attempts += 1;
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(item.packet),
    });

    const ok = res.ok;
    if (!ok) {
      item.lastError = `HTTP ${res.status}`;
      return false;
    }
    item.lastError = null;
    if (_config.environment === "development") {
      // eslint-disable-next-line no-console
      console.debug("[FamilyFundConnector] sent packet", { id: item.id });
    }
    return true;
  } catch (err) {
    item.lastError = String(err && err.message ? err.message : err);
    if (_config.environment === "development") {
      // eslint-disable-next-line no-console
      console.warn("[FamilyFundConnector] send error", { id: item.id, error: item.lastError });
    }
    return false;
  }
}

// -----------------------------------------------------------------------------
// Storage helpers (localStorage-based queue persistence)
// -----------------------------------------------------------------------------

function hydrateQueueFromStorage() {
  if (typeof window === "undefined" || typeof window.localStorage === "undefined") {
    return;
  }
  if (_queue.length > 0) return; // already loaded

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) {
      _queue = arr.map((x) => ({
        id: String(x.id || genId()),
        enqueuedAt: Number(x.enqueuedAt || Date.now()),
        attempts: Number(x.attempts || 0),
        packet: x.packet,
        lastError: x.lastError || null,
      }));
    }
  } catch {
    // ignore corrupt data
  }
}

function persistQueueToStorage() {
  if (typeof window === "undefined" || typeof window.localStorage === "undefined") {
    return;
  }
  try {
    const serializable = _queue.map((x) => ({
      id: x.id,
      enqueuedAt: x.enqueuedAt,
      attempts: x.attempts,
      packet: x.packet,
      lastError: x.lastError,
    }));
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(serializable));
  } catch {
    // ignore write errors
  }
}

// -----------------------------------------------------------------------------
// Helpers / predicates
// -----------------------------------------------------------------------------

/**
 * Is Hub export allowed by flags?
 * @returns {boolean}
 */
function isHubExportEnabled() {
  if (!_config.familyFundMode) return false;
  if (!_config.hubExport || _config.hubExport.enabled === false) return false;
  return true;
}

/**
 * Basic online check.
 * @returns {boolean}
 */
function isOnline() {
  if (typeof navigator === "undefined" || typeof navigator.onLine !== "boolean") {
    // Assume online in non-browser contexts.
    return true;
  }
  return navigator.onLine;
}

function genId() {
  return `${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

// -----------------------------------------------------------------------------
// Introspection (for debug UI, etc.)
// -----------------------------------------------------------------------------

/**
 * Light snapshot of queue for status panels / debug views.
 * DOES NOT return the full packet bodies by default to avoid huge logs.
 *
 * @param {Object} [opts]
 * @param {boolean} [opts.includePackets]
 */
export function getHubQueueSnapshot(opts = {}) {
  const includePackets = !!opts.includePackets;
  return {
    length: _queue.length,
    items: _queue.map((item) => ({
      id: item.id,
      enqueuedAt: item.enqueuedAt,
      attempts: item.attempts,
      lastError: item.lastError,
      packet: includePackets ? item.packet : undefined,
    })),
  };
}

// -----------------------------------------------------------------------------
// Default facade object (for import ergonomics)
// -----------------------------------------------------------------------------

export const FamilyFundConnector = {
  configure: configureHubConnector,
  getConfig: getHubConnectorConfig,
  export: exportToHubIfEnabled,
  enqueue: enqueuePacket,
  flush: flushHubQueue,
  getQueueSnapshot: getHubQueueSnapshot,
};

export default FamilyFundConnector;
