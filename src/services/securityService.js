// C:\Users\larho\suka-smart-assistant\src\services\securityService.js
// Suka Smart Assistant – Security Service
// -----------------------------------------------------------------------------
// PURPOSE
// - Sign and (optionally) encrypt outbound SSA → Hub packets
// - Keep SSA + Hub decoupled: SSA owns the data, Hub just receives formatted packets
// - Work in the browser, offline-first, without heavy crypto deps
// - Emit SSA-style events so the rest of the app (ImportService, dataGateway,
//   FamilyFund features) can react
//
// HOW IT FITS
// imports → intelligence → automation → (optional) hub export
// - imports/intelligence/automation produce payloads
// - dataGateway formats them to a "hub packet"
// - securityService signs + encrypts the packet
// - FamilyFundConnector actually sends to the Hub
//
// DESIGN GOALS
// - Forward-thinking: support more algorithms later (ECDSA, RSA, remote KMS)
// - Defensive: if crypto not available, still return a packet marked
//   { insecure: true } so we never silently drop data
// - Key management: keep a small key registry in localStorage/Dexie-like storage
//   so you can rotate keys without reconfiguring all clients
//
// -----------------------------------------------------------------------------


/* eslint-disable no-console */

const isBrowser = typeof window !== "undefined";

// ------------------------------ Defensive imports ----------------------------
let eventBus = { emit() {}, on() {}, off() {} };
try {
  // eslint-disable-next-line global-require
  const eb = require("@/services/eventBus");
  eventBus = (eb && (eb.default || eb.eventBus || eb)) || eventBus;
} catch (_e) {}

let featureFlags = { familyFundMode: false };
try {
  // eslint-disable-next-line global-require
  const ff = require("@/config/featureFlags.json");
  featureFlags = ff || featureFlags;
} catch (_e) {}

let HubPacketFormatter = null;
try {
  // eslint-disable-next-line global-require
  const f = require("@/services/HubPacketFormatter");
  HubPacketFormatter = f.HubPacketFormatter || f.default || f || null;
} catch (_e) {}

let FamilyFundConnector = null;
try {
  // eslint-disable-next-line global-require
  const c = require("@/services/FamilyFundConnector");
  FamilyFundConnector = c.FamilyFundConnector || c.default || c || null;
} catch (_e) {}


// ------------------------------ Constants ------------------------------------
const STORAGE_KEY = "suka.security.keys.v1";
const DEFAULT_ALG = "HMAC-SHA256";      // for signatures
const DEFAULT_ENC = "AES-GCM";          // for encryption
const DEFAULT_KEY_ID = "ssa-local-1";   // first local key
const SOURCE = "securityService";


// ------------------------------ Helpers --------------------------------------
function nowIso() {
  return new Date().toISOString();
}

function emitSSA(type, data = {}) {
  const evt = { type, ts: nowIso(), source: SOURCE, data };
  try {
    eventBus.emit(type, evt);
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

// base64 helpers
function toBase64(buf) {
  if (!buf) return "";
  if (buf instanceof ArrayBuffer) {
    // eslint-disable-next-line no-undef
    return btoa(String.fromCharCode(...new Uint8Array(buf)));
  }
  if (typeof buf === "string") {
    // eslint-disable-next-line no-undef
    return btoa(buf);
  }
  // assume Uint8Array
  // eslint-disable-next-line no-undef
  return btoa(String.fromCharCode(...buf));
}

function fromBase64(b64) {
  if (!b64) return new Uint8Array();
  // eslint-disable-next-line no-undef
  const str = atob(b64);
  const arr = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i += 1) arr[i] = str.charCodeAt(i);
  return arr;
}

function randomBytes(len = 16) {
  if (isBrowser && window.crypto?.getRandomValues) {
    const a = new Uint8Array(len);
    window.crypto.getRandomValues(a);
    return a;
  }
  // fallback: weak randomness
  const a = new Uint8Array(len);
  for (let i = 0; i < len; i += 1) {
    a[i] = Math.floor(Math.random() * 256);
  }
  return a;
}

// ------------------------------ Key Registry ---------------------------------
function loadKeyRegistry() {
  if (!isBrowser) {
    return {
      activeKeyId: DEFAULT_KEY_ID,
      keys: {
        [DEFAULT_KEY_ID]: {
          id: DEFAULT_KEY_ID,
          alg: DEFAULT_ALG,
          enc: DEFAULT_ENC,
          // VERY IMPORTANT:
          // in real deployment, you would *not* store secrets like this in plaintext
          // here we do it because we're offline-first and no backend was defined
          secret: toBase64(randomBytes(32)),
          createdAt: nowIso()
        }
      }
    };
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      const reg = {
        activeKeyId: DEFAULT_KEY_ID,
        keys: {
          [DEFAULT_KEY_ID]: {
            id: DEFAULT_KEY_ID,
            alg: DEFAULT_ALG,
            enc: DEFAULT_ENC,
            secret: toBase64(randomBytes(32)),
            createdAt: nowIso()
          }
        }
      };
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(reg));
      return reg;
    }
    return JSON.parse(raw);
  } catch (_e) {
    return {
      activeKeyId: DEFAULT_KEY_ID,
      keys: {
        [DEFAULT_KEY_ID]: {
          id: DEFAULT_KEY_ID,
          alg: DEFAULT_ALG,
          enc: DEFAULT_ENC,
          secret: toBase64(randomBytes(32)),
          createdAt: nowIso()
        }
      }
    };
  }
}

function saveKeyRegistry(reg) {
  if (!isBrowser) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(reg));
  } catch (_e) {}
}

async function deriveCryptoKey(secretB64, usage = ["sign", "verify"]) {
  if (!isBrowser || !window.crypto?.subtle) return null;
  const raw = fromBase64(secretB64);
  try {
    return await window.crypto.subtle.importKey(
      "raw",
      raw,
      { name: "HMAC", hash: "SHA-256" },
      false,
      usage
    );
  } catch (_e) {
    return null;
  }
}

async function deriveEncKey(secretB64) {
  if (!isBrowser || !window.crypto?.subtle) return null;
  const raw = fromBase64(secretB64);
  try {
    return await window.crypto.subtle.importKey(
      "raw",
      raw,
      { name: "AES-GCM" },
      false,
      ["encrypt", "decrypt"]
    );
  } catch (_e) {
    return null;
  }
}


// ------------------------------ Core Service ---------------------------------
export const securityService = {
  /**
   * Returns the current key registry (active key + map)
   */
  getKeyRegistry() {
    return loadKeyRegistry();
  },

  /**
   * Rotate to a new local key
   */
  rotateKey({ alg = DEFAULT_ALG, enc = DEFAULT_ENC } = {}) {
    const reg = loadKeyRegistry();
    const newId = `ssa-${Math.random().toString(36).slice(2, 10)}`;
    reg.keys[newId] = {
      id: newId,
      alg,
      enc,
      secret: toBase64(randomBytes(32)),
      createdAt: nowIso()
    };
    reg.activeKeyId = newId;
    saveKeyRegistry(reg);
    emitSSA("security.key.rotated", { keyId: newId, alg, enc });
    return newId;
  },

  /**
   * Sign a JS object or string payload
   * returns { signature, keyId, alg }
   */
  async signPayload(payload, keyId) {
    const reg = loadKeyRegistry();
    const activeKeyId = keyId || reg.activeKeyId;
    const keyEntry = reg.keys[activeKeyId];
    if (!keyEntry) {
      emitSSA("security.error", { reason: "missing-key", keyId: activeKeyId });
      return {
        signature: null,
        keyId: activeKeyId,
        alg: keyEntry?.alg || DEFAULT_ALG,
        insecure: true
      };
    }

    const { secret, alg } = keyEntry;
    const messageStr = typeof payload === "string" ? payload : JSON.stringify(payload);

    // if Web Crypto is available
    if (isBrowser && window.crypto?.subtle) {
      try {
        const cryptoKey = await deriveCryptoKey(secret, ["sign"]);
        if (cryptoKey) {
          const sigBuf = await window.crypto.subtle.sign(
            { name: "HMAC" },
            cryptoKey,
            new TextEncoder().encode(messageStr)
          );
          const sig = toBase64(sigBuf);
          return { signature: sig, keyId: activeKeyId, alg, insecure: false };
        }
      } catch (err) {
        console.warn("[securityService] sign error, falling back:", err);
      }
    }

    // fallback – weak HMAC-ish (NOT for prod, but keeps the pipeline)
    const weak = toBase64(
      new TextEncoder().encode(`${messageStr}.${secret}.${activeKeyId}`).slice(0, 32)
    );
    return { signature: weak, keyId: activeKeyId, alg, insecure: true };
  },

  /**
   * Verify signature (best-effort). Returns boolean.
   */
  async verifySignature(payload, { signature, keyId }) {
    if (!signature || !keyId) return false;
    const reg = loadKeyRegistry();
    const keyEntry = reg.keys[keyId];
    if (!keyEntry) return false;
    const ownSig = await this.signPayload(payload, keyId);
    return ownSig.signature === signature;
  },

  /**
   * Encrypts payload (best-effort)
   * returns { cipher, iv, keyId, alg, insecure? }
   */
  async encryptPayload(payload, keyId) {
    const reg = loadKeyRegistry();
    const activeKeyId = keyId || reg.activeKeyId;
    const keyEntry = reg.keys[activeKeyId];
    const dataStr = typeof payload === "string" ? payload : JSON.stringify(payload);

    if (!keyEntry) {
      emitSSA("security.error", { reason: "missing-key", keyId: activeKeyId });
      return {
        cipher: toBase64(new TextEncoder().encode(dataStr)),
        iv: null,
        keyId: activeKeyId,
        alg: DEFAULT_ENC,
        insecure: true
      };
    }

    const { secret, enc } = keyEntry;

    if (isBrowser && window.crypto?.subtle) {
      try {
        const encKey = await deriveEncKey(secret);
        const iv = randomBytes(12);
        const cipherBuf = await window.crypto.subtle.encrypt(
          { name: "AES-GCM", iv },
          encKey,
          new TextEncoder().encode(dataStr)
        );
        return {
          cipher: toBase64(cipherBuf),
          iv: toBase64(iv),
          keyId: activeKeyId,
          alg: enc,
          insecure: false
        };
      } catch (err) {
        console.warn("[securityService] encrypt error, falling back:", err);
      }
    }

    // fallback: base64-only
    return {
      cipher: toBase64(new TextEncoder().encode(dataStr)),
      iv: null,
      keyId: activeKeyId,
      alg: enc,
      insecure: true
    };
  },

  /**
   * Build an outbound SSA → Hub packet:
   * 1. format (if HubPacketFormatter available)
   * 2. sign
   * 3. encrypt (optional, controlled by opts.encrypt)
   */
  async buildSecurePacket(payload, opts = {}) {
    const { encrypt = true, keyId: forcedKeyId } = opts;

    // STEP 1: format
    let formatted = payload;
    if (HubPacketFormatter && typeof HubPacketFormatter.formatPacket === "function") {
      try {
        formatted = HubPacketFormatter.formatPacket(payload);
      } catch (_e) {
        // keep original
      }
    }

    // STEP 2: sign
    const sig = await this.signPayload(formatted, forcedKeyId);
    const envelope = {
      // SSA event envelope shape
      type: "ssa.packet.outbound",
      ts: nowIso(),
      source: SOURCE,
      data: {
        payload: formatted,
        signature: sig.signature,
        keyId: sig.keyId,
        alg: sig.alg,
        insecure: !!sig.insecure
      }
    };

    // STEP 3: encrypt, if asked
    if (encrypt) {
      const enc = await this.encryptPayload(envelope.data, sig.keyId);
      envelope.data = {
        encrypted: true,
        cipher: enc.cipher,
        iv: enc.iv,
        keyId: enc.keyId,
        alg: enc.alg,
        insecure: !!enc.insecure
      };
    }

    emitSSA("security.packet.built", { encrypt, keyId: sig.keyId, insecure: envelope.data.insecure });
    return envelope;
  },

  /**
   * Send a signed+encrypted packet, honoring familyFundMode
   * This is a convenience so dataGateway can just call one thing.
   */
  async sendToHub(payload, opts = {}) {
    if (!featureFlags.familyFundMode) {
      // not in hub mode – return packet but do not send
      const pkt = await this.buildSecurePacket(payload, opts);
      emitSSA("security.packet.skipped-hub", { reason: "familyFundMode=false" });
      return { sent: false, packet: pkt };
    }

    const packet = await this.buildSecurePacket(payload, opts);
    if (!FamilyFundConnector || typeof FamilyFundConnector.send !== "function") {
      emitSSA("security.packet.skipped-hub", { reason: "no-FamilyFundConnector" });
      return { sent: false, packet };
    }

    try {
      await FamilyFundConnector.send(packet);
      emitSSA("security.packet.sent", { keyId: packet.data.keyId, encrypted: packet.data.encrypted === true });
      return { sent: true, packet };
    } catch (err) {
      emitSSA("security.packet.send-failed", { error: err?.message || String(err) });
      return { sent: false, packet, error: err };
    }
  }
};


// auto-register a first init event in browser
if (isBrowser) {
  emitSSA("security.init", { activeKeyId: loadKeyRegistry().activeKeyId });
}
