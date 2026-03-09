// C:\Users\larho\suka-smart-assistant\src\services\dataGateway.js
// Suka Smart Assistant – Data Gateway
// -----------------------------------------------------------------------------
// PURPOSE
// - This is the *single* outward-facing data gateway for SSA → Hub (SVFFH or other).
// - Any SSA module that produces household-changing data (inventory updates,
//   storehouse goals/stocks, garden harvest logs, animal/butchery sessions,
//   preservation runs, multi-household co-op plans) should call THIS gateway.
// - The gateway:
//     1. Normalizes the payload to SSA’s hub-friendly envelope
//     2. Signs the batch (lightweight, browser-safe)
//     3. Routes through HubPacketFormatter (assume exists) to match Hub protocol
//     4. Sends via FamilyFundConnector (assume exists)
//     5. Emits SSA events in the unified shape { type, ts, source, data }
//
// WHY THIS MATTERS
// - You said: “SSA may have familyFundMode=true which means: ‘also format this data
//   to send to the Hub,’ but SSA still owns the data first.” This file enforces that.
// - SSA can run completely alone. If familyFundMode is OFF or Hub is unreachable,
//   we *silently* skip network export; SSA keeps working.
//
// WHERE IT FITS
// imports → intelligence → automation → (optional) hub export
// e.g.
//   src/services/scraperService.js → detects storehouse-stock → calls dataGateway.exportIfEnabled(...)
//   src/domain/inventory/InventorySessionEngine.js → emits inventory.updated → calls dataGateway.send(...)
//   src/services/session/RelativeScheduler.js → when a preservation/cooking session is completed → calls here
//
// FORWARD-THINKING
// - Supports domain types now: recipe, meal, cleaning, garden, harvest, preservation,
//   animal, butchery, storehouse, scan/receipt
// - Easy to add: energy, construction, logistics, susu-finance, coop-labor
// -----------------------------------------------------------------------------

/* eslint-disable no-console */

const isBrowser = typeof window !== "undefined";

// ------------------------------ Defensive imports ----------------------------
let eventBus = { emit() {}, on() {}, off() {} };
try {
  // eslint-disable-next-line global-require
  const eb = require("@/services/events/eventBus");
  eventBus = (eb && (eb.default || eb.eventBus || eb)) || eventBus;
} catch (_e) {
  // ok – window will still get events
}

let featureFlags = { familyFundMode: false };
try {
  // eslint-disable-next-line global-require
  const ff = require("@/config/featureFlags.json");
  featureFlags = ff || featureFlags;
} catch (_e) {}

let HubPacketFormatter = null;
try {
  // eslint-disable-next-line global-require
  HubPacketFormatter = require("@/services/hub/HubPacketFormatter");
} catch (_e) {}

let FamilyFundConnector = null;
try {
  // eslint-disable-next-line global-require
  FamilyFundConnector = require("@/services/hub/FamilyFundConnector");
} catch (_e) {}

let schemaValidator = null;
try {
  // eslint-disable-next-line global-require
  const sv = require("@/services/schemaValidator");
  schemaValidator = sv.schemaValidator || sv;
} catch (_e) {}

let runtimeEnv = { HUB_SIGNING_KEY: "" };
try {
  // eslint-disable-next-line global-require
  runtimeEnv = require("@/config/env") || runtimeEnv;
} catch (_e) {}

// ------------------------------ Internal state -------------------------------
// we batch small exports so we don't spam the Hub
const BATCH_MAX = 25;
const STATE = {
  queue: [], // array of { domain, action, payload, ts, meta }
  flushing: false,
};

// ------------------------------ Utils ----------------------------------------
function nowIso() {
  return new Date().toISOString();
}

function emitSSA(type, data = {}, source = "dataGateway") {
  const evt = { type, ts: nowIso(), source, data };

  try {
    if (eventBus && typeof eventBus.emit === "function") {
      eventBus.emit(type, evt);
    }
  } catch (_e) {}

  if (isBrowser) {
    try {
      window.dispatchEvent(new CustomEvent(type, { detail: evt }));
    } catch (_e) {}
    try {
      const bus = window.__suka?.eventBus;
      if (bus?.emit) bus.emit(type, evt);
    } catch (_e) {}
  }

  return evt;
}

// lightweight, browser-safe “signing” (NOT cryptographic HSM – just integrity-ish)
// If crypto.subtle is available, we use HMAC-SHA-256. Otherwise we fallback to a
// simple hash-like string.
async function signPayload(raw, key) {
  const dataStr = typeof raw === "string" ? raw : JSON.stringify(raw);
  const secret = key || runtimeEnv.HUB_SIGNING_KEY || "suka-local-dev-key";

  // WebCrypto path
  if (isBrowser && window.crypto?.subtle) {
    try {
      const enc = new TextEncoder();
      const keyObj = await window.crypto.subtle.importKey(
        "raw",
        enc.encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"]
      );
      const sigBuf = await window.crypto.subtle.sign(
        "HMAC",
        keyObj,
        enc.encode(dataStr)
      );
      const sigArr = Array.from(new Uint8Array(sigBuf))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      return sigArr;
    } catch (_e) {
      // fall back
    }
  }

  // fallback – non-crypto
  let hash = 0;
  for (let i = 0; i < dataStr.length; i += 1) {
    hash = (hash << 5) - hash + dataStr.charCodeAt(i);
    // eslint-disable-next-line no-bitwise
    hash |= 0;
  }
  return `weak-${Math.abs(hash)}-${Date.now().toString(36)}`;
}

// builds the SSA → Hub standard packet
function buildPacket(batchItems = [], extraMeta = {}) {
  const base = {
    version: "1.0.0",
    family: "suka-smart-assistant",
    producedAt: nowIso(),
    items: batchItems,
    meta: {
      ...extraMeta,
      itemCount: batchItems.length,
    },
  };
  return base;
}

// sanity check – when imports produce storehouse/inventory/garden/animal data
// we run through schemaValidator *if available*
function validateForExport(item) {
  if (!schemaValidator) return { valid: true, errors: [] };
  // we only validate import-like / inventory-like payloads
  if (item?.payload?.__importType) {
    return schemaValidator.validateImport(item.payload);
  }
  return { valid: true, errors: [] };
}

// ------------------------------ Core API -------------------------------------
export const dataGateway = {
  /**
   * enqueue a single exportable item
   * item: {
   *   domain: "inventory"|"storehouse"|"garden"|"animal"|"butchery"|"preservation"|string,
   *   action: "updated"|"logged"|"completed"|"synced"|string,
   *   payload: {...},  // SSA-native object
   *   meta?: {...}
   * }
   *
   * This does NOT guarantee immediate network send; we flush in small batches.
   */
  async enqueue(item = {}) {
    if (!item || typeof item !== "object") return;

    // If feature is off → we still emit locally but don't send
    const familyEnabled = !!(featureFlags && featureFlags.familyFundMode);

    const record = {
      domain: item.domain || "generic",
      action: item.action || "updated",
      payload: item.payload || {},
      ts: nowIso(),
      meta: item.meta || {},
    };

    // validate if possible – if hard error we can still keep it but mark
    const { valid, errors } = validateForExport(record);
    if (!valid) {
      record.meta.validationErrors = errors;
    }

    STATE.queue.push(record);

    emitSSA("hub.export.enqueued", {
      item: record,
      queueLength: STATE.queue.length,
    });

    // simple heuristic: if queue is big, flush
    if (STATE.queue.length >= BATCH_MAX) {
      await this.flush();
    } else if (familyEnabled) {
      // small auto-flush for enabled hubs
      await this.flush();
    }
  },

  /**
   * flush the current queue into 1..N batches and send to the Hub
   */
  async flush({ force = false } = {}) {
    // if feature is off and not forced → don't send to Hub, but do emit local event
    const familyEnabled = !!(featureFlags && featureFlags.familyFundMode);
    if (!familyEnabled && !force) {
      if (STATE.queue.length > 0) {
        emitSSA("hub.export.skipped", {
          reason: "familyFundMode=false",
          skippedCount: STATE.queue.length,
        });
        // we DO NOT drop the queue here – user may turn on hub later
      }
      return;
    }

    if (STATE.flushing) return;
    STATE.flushing = true;

    try {
      // slice a batch
      const batch = STATE.queue.splice(0, BATCH_MAX);
      if (!batch.length) {
        STATE.flushing = false;
        return;
      }

      // build packet
      let packet = buildPacket(batch, {
        source: "ssa-data-gateway",
        householdId: getHouseholdIdFallback(),
        node: isBrowser ? "browser" : "node",
      });

      // format for hub, if formatter is present
      if (
        HubPacketFormatter &&
        typeof HubPacketFormatter.toHubPacket === "function"
      ) {
        try {
          packet = HubPacketFormatter.toHubPacket(packet);
        } catch (err) {
          console.warn(
            "[dataGateway] HubPacketFormatter failed, sending raw packet",
            err
          );
        }
      }

      // sign packet
      const signature = await signPayload(packet, runtimeEnv.HUB_SIGNING_KEY);
      packet.signature = signature;

      // send
      if (
        FamilyFundConnector &&
        typeof FamilyFundConnector.send === "function"
      ) {
        try {
          await FamilyFundConnector.send(packet);
          emitSSA("hub.export.sent", {
            packetMeta: {
              count: batch.length,
              signature,
              householdId: packet?.meta?.householdId || null,
            },
          });
        } catch (err) {
          // network / auth / offline → we KEEP the batch by pushing it back
          console.warn("[dataGateway] send failed, re-queueing", err);
          STATE.queue.unshift(...batch); // put back
          emitSSA("hub.export.failed", {
            error: err?.message || String(err),
            count: batch.length,
          });
        }
      } else {
        // no connector → pretend success locally
        emitSSA("hub.export.sent.local-only", {
          packetMeta: { count: batch.length, signature },
        });
      }
    } finally {
      STATE.flushing = false;
    }
  },

  /**
   * convenience: export one item *right now* (bypasses batching)
   * good for: inventory.updated, garden.harvest.logged, preservation.completed
   */
  async sendImmediate(item = {}) {
    await this.enqueue(item);
    await this.flush({ force: true });
  },

  /**
   * utility used by other SSA services:
   *  dataGateway.exportIfEnabled("storehouse", "stockSynced", payload)
   */
  async exportIfEnabled(domain, action, payload, meta = {}) {
    const familyEnabled = !!(featureFlags && featureFlags.familyFundMode);
    const record = { domain, action, payload, meta };
    // always emit locally
    emitSSA("hub.export.requested", record);

    if (!familyEnabled) {
      return false;
    }
    await this.sendImmediate(record);
    return true;
  },

  /**
   * view current queue (for debug / analytics panel)
   */
  peekQueue() {
    return [...STATE.queue];
  },
};

// ------------------------------ Small helpers --------------------------------
function getHouseholdIdFallback() {
  // try to retrieve from window.__suka if present
  if (isBrowser) {
    const id =
      window.__suka?.profile?.householdId ||
      window.__suka?.householdId ||
      window.localStorage?.getItem("suka.householdId");
    if (id) return id;
  }
  return "ssa-local-household";
}

// ✅ Build-fix: allow `import dataGateway from "../services/dataGateway.js";`
export default dataGateway;
