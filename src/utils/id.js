/* eslint-disable no-console */
/**
 * uuid helpers for session/task ids
 * Style: ES2015-safe, zero 3rd-party deps, defensive DI, browser/node compatible
 *
 * Exports (named + default):
 * - v4()                 -> RFC4122 v4 (random)
 * - v7()                 -> Draft UUIDv7 (time-ordered, ms)
 * - ulid()               -> Crockford ULID (time-ordered, lexicographic)
 * - shortId(len?)        -> base62 compact id (default 21)
 * - fromContent(content, namespace?) -> deterministic stable id for favorites
 * - ensureId(obj, opts)  -> attach {id,prefix} like sess_, sched_, fav_
 * - parse(id)            -> { prefix, raw, kind, isUUID, isULID, tsHint }
 * - NS                   -> well-known namespaces for consistency
 * - encodeBase62(bytes)  -> utility
 *
 * Optional deps via DI (no hard requirement):
 * - eventBus: { emit(evt, payload):void }
 * - analytics: { track(evt, payload):void }
 */

(function () {
  /* ------------------------------ DI + options ------------------------------ */
  const logger = console;

  let eventBus = { emit: () => {} };
  try {
    // Prefer your shared event bus if available
    const eb = require("@/services/events/eventBus");
    eventBus = (eb && (eb.default || eb.eventBus || eb)) || eventBus;
  } catch (_e) {}

  let analytics = { track: () => {} };
  try {
    const an = require("@/services/analytics");
    analytics = (an && (an.default || an.analytics || an)) || analytics;
  } catch (_e) {}

  /* ----------------------------- Env detection ------------------------------ */
  const isBrowser = typeof window !== "undefined";
  const _crypto =
    (isBrowser && (window.crypto || window.msCrypto)) ||
    (typeof require === "function"
      ? (function () {
          try {
            return require("crypto").webcrypto || require("crypto");
          } catch (_e) {
            return null;
          }
        })()
      : null);

  const hasRandomUUID = !!(_crypto && _crypto.randomUUID);
  const hasGetRandomValues = !!(_crypto && _crypto.getRandomValues);

  /* ------------------------------ Small helpers ----------------------------- */
  const nowMs = () => Date.now();

  function randomBytes(n) {
    const buf = new Uint8Array(n);
    if (hasGetRandomValues) {
      _crypto.getRandomValues(buf);
      return buf;
    }
    // Fallback (not crypto-strong): Mulberry32 seeded by time + Math.random
    let seed = (nowMs() ^ (Math.random() * 0xffffffff)) >>> 0;
    const mulberry32 = (t) => {
      return function () {
        t |= 0;
        t = (t + 0x6d2b79f5) | 0;
        let r = Math.imul(t ^ (t >>> 15), 1 | t);
        r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
        return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
      };
    };
    const rnd = mulberry32(seed);
    for (let i = 0; i < n; i++) buf[i] = (rnd() * 256) | 0;
    return buf;
  }

  function hex(bytes) {
    let s = "";
    for (let i = 0; i < bytes.length; i++) {
      const h = bytes[i].toString(16).padStart(2, "0");
      s += h;
    }
    return s;
  }

  function encodeBase62(bytes) {
    // Minimal base62 for compact IDs; avoids carrying large libs
    const alphabet =
      "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
    // Convert bytes to BigInt then to base62 string (works up to modest byte lengths)
    let value = 0n;
    for (let i = 0; i < bytes.length; i++) {
      value = (value << 8n) | BigInt(bytes[i]);
    }
    if (value === 0n) return "0";
    let out = "";
    while (value > 0n) {
      const rem = Number(value % 62n);
      out = alphabet[rem] + out;
      value = value / 62n;
    }
    return out;
  }

  /* ------------------------------- UUID v4 ---------------------------------- */
  function v4() {
    if (hasRandomUUID && typeof _crypto.randomUUID === "function") {
      return _crypto.randomUUID();
    }
    // Manual v4 (RFC4122)
    const b = randomBytes(16);
    b[6] = (b[6] & 0x0f) | 0x40; // version 4
    b[8] = (b[8] & 0x3f) | 0x80; // variant RFC4122
    const h = hex(b);
    return (
      h.substr(0, 8) +
      "-" +
      h.substr(8, 4) +
      "-" +
      h.substr(12, 4) +
      "-" +
      h.substr(16, 4) +
      "-" +
      h.substr(20)
    );
  }

  /* ------------------------------- UUID v7 ---------------------------------- */
  // UUIDv7 layout: time-ordered (48-bit Unix ms), version(4 bits)=7, var(2 bits)=RFC, plus randomness
  function v7() {
    const t = BigInt(nowMs()); // 48 bits
    const rnd = randomBytes(10); // remaining 80 bits
    // Build 128-bit buffer
    const b = new Uint8Array(16);

    // Write 48-bit timestamp (big-endian)
    b[0] = Number((t >> 40n) & 0xffn);
    b[1] = Number((t >> 32n) & 0xffn);
    b[2] = Number((t >> 24n) & 0xffn);
    b[3] = Number((t >> 16n) & 0xffn);
    b[4] = Number((t >> 8n) & 0xffn);
    b[5] = Number(t & 0xffn);

    // version (4 bits = 7) across b[6]
    b[6] = (rnd[0] & 0x0f) | 0x70;

    // variant RFC 4122 (10xx)
    b[8] = (rnd[2] & 0x3f) | 0x80;

    // fill remaining random bytes
    b[7] = rnd[1];
    b[9] = rnd[3];
    b[10] = rnd[4];
    b[11] = rnd[5];
    b[12] = rnd[6];
    b[13] = rnd[7];
    b[14] = rnd[8];
    b[15] = rnd[9];

    const h = hex(b);
    return (
      h.substr(0, 8) +
      "-" +
      h.substr(8, 4) +
      "-" +
      h.substr(12, 4) +
      "-" +
      h.substr(16, 4) +
      "-" +
      h.substr(20)
    );
  }

  /* -------------------------------- ULID ------------------------------------ */
  // ULID spec: https://github.com/ulid/spec (monotonic not required here)
  const ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford (no I,L,O,U)
  function _encodeCrockfordBase32(value, pad) {
    let out = "";
    for (let i = 0; i < pad; i++) {
      out = ULID_ALPHABET[value & 31] + out;
      value = value >>> 5;
    }
    return out;
  }
  function ulid() {
    const time = nowMs();
    const timePart = (() => {
      // 48-bit time => 10 chars base32
      let v = time;
      const chars = new Array(10);
      for (let i = 9; i >= 0; i--) {
        chars[i] = ULID_ALPHABET[v % 32];
        v = Math.floor(v / 32);
      }
      return chars.join("");
    })();
    const rnd = randomBytes(16);
    // 80 random bits => 16 chars base32
    let rOut = "";
    for (let i = 0; i < 16; i++) {
      rOut += ULID_ALPHABET[rnd[i] & 31];
    }
    return timePart + rOut;
  }

  /* ----------------------------- Deterministic ID ---------------------------- */
  // Deterministic (stable) ID from content + (optional) namespace.
  // Uses a simple 128-bit FNV-1a-like mix then renders as base62.
  function _hash128(bytes) {
    // 128-bit state using BigInt
    let h1 = 0x9e3779b185ebca87n; // golden ratio
    let h2 = 0xc2b2ae3d27d4eb4fn;
    for (let i = 0; i < bytes.length; i++) {
      const x = BigInt(bytes[i]);
      h1 ^= x + 0x100n;
      h1 = (h1 * 0x100000001b3n) & 0xffffffffffffffffn; // FNV-ish
      h2 ^= (x << 1n) + 0x200n;
      h2 = (h2 * 0x9e3779b97f4a7c15n) & 0xffffffffffffffffn;
    }
    // concat to 16 bytes
    const out = new Uint8Array(16);
    for (let i = 0; i < 8; i++) {
      out[7 - i] = Number((h1 >> BigInt(i * 8)) & 0xffn);
      out[15 - i] = Number((h2 >> BigInt(i * 8)) & 0xffn);
    }
    return out;
  }

  function _toBytes(input) {
    if (input == null) return new Uint8Array([0]);
    if (typeof input === "string") {
      // UTF-8 encode
      const enc =
        typeof TextEncoder !== "undefined"
          ? new TextEncoder()
          : { encode: (s) => Buffer.from(s, "utf8") };
      return enc.encode(input);
    }
    if (typeof input === "object") {
      try {
        const s = JSON.stringify(input, Object.keys(input).sort());
        return _toBytes(s);
      } catch (_e) {
        return _toBytes(String(input));
      }
    }
    return _toBytes(String(input));
  }

  const NS = Object.freeze({
    ROOT: "suka",
    SESSION: "suka:session",
    SCHEDULE: "suka:schedule",
    FAVORITE: "suka:favorite",
    PLAN: "suka:plan",
    TASK: "suka:task",
  });

  function fromContent(content, namespace = NS.ROOT) {
    const nb = _toBytes(namespace);
    const cb = _toBytes(content);
    const combined = new Uint8Array(nb.length + 1 + cb.length);
    combined.set(nb, 0);
    combined.set([0x00], nb.length);
    combined.set(cb, nb.length + 1);
    const digest = _hash128(combined);
    const id = encodeBase62(digest); // compact + URL-safe
    return id;
  }

  /* ------------------------------- shortId ---------------------------------- */
  function shortId(len = 21) {
    // Generate base62 from 16 random bytes and trim/pad to len
    const bytes = randomBytes(Math.ceil((len * 6) / 8)); // 6 bits per char approx
    let s = encodeBase62(bytes);
    if (s.length > len) s = s.slice(0, len);
    if (s.length < len) {
      // deterministic pad with extra randomness
      s += encodeBase62(randomBytes(8)).slice(0, len - s.length);
    }
    return s;
  }

  /* --------------------------------- parse ---------------------------------- */
  function parse(id) {
    if (typeof id !== "string") return { prefix: "", raw: "", kind: "unknown" };
    const m = id.match(/^([a-z]+_)(.+)$/i);
    const prefix = m ? m[1] : "";
    const raw = m ? m[2] : id;

    const isUUID =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-7][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        raw
      );
    const isULID = /^[0-9A-HJKMNP-TV-Z]{26}$/.test(raw);

    let kind = "other";
    if (prefix.startsWith("sess_")) kind = "session";
    else if (prefix.startsWith("sched_")) kind = "schedule";
    else if (prefix.startsWith("fav_")) kind = "favorite";
    else if (prefix.startsWith("plan_")) kind = "plan";
    else if (prefix.startsWith("task_")) kind = "task";

    let tsHint = null;
    if (isULID) {
      // ULID first 10 chars are time in base32
      const alphabet = ULID_ALPHABET;
      let t = 0;
      for (let i = 0; i < 10; i++) {
        t = t * 32 + alphabet.indexOf(raw[i]);
      }
      tsHint = t; // ms
    } else if (/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/i.test(raw)) {
      // v7: first 6 bytes are time ms
      const h = raw.replace(/-/g, "");
      const tHex = h.slice(0, 12); // 48 bits
      tsHint = parseInt(tHex, 16);
    }

    return {
      prefix,
      raw,
      kind,
      isUUID,
      isULID,
      tsHint: Number.isFinite(tsHint) ? tsHint : null,
    };
  }

  /* ------------------------------- ensureId --------------------------------- */
  /**
   * ensureId(obj, { type, strategy, deterministicKey })
   * type: 'session' | 'schedule' | 'favorite' | 'plan' | 'task'
   * strategy: 'v7' | 'ulid' | 'v4' | 'short'
   * deterministicKey: any (used when type==='favorite' or when you want stability)
   */
  function ensureId(obj = {}, opts = {}) {
    const { type = "task", strategy, deterministicKey } = opts;

    // Prefix by type for better readability & query grouping in Dexie/Indexes
    const prefix =
      type === "session"
        ? "sess_"
        : type === "schedule"
        ? "sched_"
        : type === "favorite"
        ? "fav_"
        : type === "plan"
        ? "plan_"
        : "task_";

    let raw = obj.id;
    if (!raw || typeof raw !== "string") {
      if (type === "favorite" || deterministicKey != null) {
        // Deterministic for user-saved favorites (stable across devices)
        raw = fromContent(deterministicKey ?? obj, NS.FAVORITE);
      } else {
        const strat =
          strategy ||
          (type === "session" || type === "schedule" ? "v7" : "short");
        if (strat === "v7") raw = v7();
        else if (strat === "ulid") raw = ulid();
        else if (strat === "v4") raw = v4();
        else raw = shortId(); // default compact
      }
    }

    const id = prefix + raw;

    // Emit/track for collision insights (dexie unique index should rarely collide)
    if (obj.id && obj.id !== id) {
      eventBus.emit("id:collision", { previous: obj.id, next: id, type });
      analytics.track("id_collision", { type, previous: obj.id, next: id });
      if (logger && logger.warn)
        logger.warn("[id] Collision/override detected", obj.id, "->", id);
    } else {
      eventBus.emit("id:generated", { id, type, strategy: strategy || "auto" });
    }

    obj.id = id;
    return id;
  }

  /* ------------------------------ Public API -------------------------------- */
  const api = {
    v4,
    v7,
    ulid,
    shortId,
    fromContent,
    ensureId,
    parse,
    encodeBase62,
    NS,
  };

  // ESM default + named
  try {
    module.exports = api;
    module.exports.default = api;
  } catch (_e) {}

  try {
    // Support ESM import { v7 } from "@/utils/id"
    if (typeof exports !== "undefined") {
      Object.assign(exports, api);
      exports.default = api;
    }
  } catch (_e) {}

  // Browser global fallback (dev consoles, sandboxes)
  if (isBrowser) {
    const root = window || {};
    root.SukaIdUtils = root.SukaIdUtils || api;
  }
})();
