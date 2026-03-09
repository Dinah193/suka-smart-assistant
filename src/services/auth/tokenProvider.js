// File: src/services/auth/tokenProvider.js
/**
 * tokenProvider
 * -----------------------------------------------------------------------------
 * SSA browser-safe token abstraction.
 *
 * Goals
 *  - Provide a single place for access tokens (and refresh logic later)
 *  - Work in pure client builds (Vite) with zero node imports
 *  - Degrade gracefully (memory-only if storage unavailable)
 *  - Support multiple token "kinds" (access, refresh, id) without forcing it
 *  - Emit auth events through SSA eventBus (optional; never crashes)
 *
 * EventBus integration
 *  - Your eventBus enforces payload shape:
 *      { type, ts, source, data }
 *    and does NOT re-wrap if callers pass that shape already.
 *  - This provider supports both common emitter APIs:
 *      emit(type, data, source)
 *      emit(payloadObject)
 *
 * Exports
 *  - default tokenProvider object
 *  - named helpers: getToken, setToken, clearToken, parseJwt, etc.
 */

import * as EventBusMod from "../events/eventBus.js";

const SOURCE = "auth.tokenProvider";

/* ----------------------------- event bus resolve ---------------------------- */
const eventBus =
  EventBusMod?.eventBus || EventBusMod?.default || EventBusMod || null;

function nowISO() {
  return new Date().toISOString();
}

/**
 * busEmit(type, data)
 * - Tries best-effort to emit via your SSA bus without assuming a single API.
 * - Prefers emit(type, data, source) if available, else emits a shaped payload.
 */
function busEmit(type, data) {
  try {
    if (!eventBus) return;

    const shaped = { type, ts: nowISO(), source: SOURCE, data: data || {} };

    const emitFn =
      (typeof eventBus.emit === "function" && eventBus.emit) ||
      (typeof eventBus.publish === "function" && eventBus.publish) ||
      null;

    if (!emitFn) return;

    // If emitter accepts a single argument, pass the fully-shaped payload.
    if (emitFn.length <= 1) {
      emitFn.call(eventBus, shaped);
      return;
    }

    // Otherwise, prefer (type, data, source) shape.
    // Your bus will wrap into { type, ts, source, data } consistently.
    emitFn.call(eventBus, type, data || {}, SOURCE);
  } catch {
    // never crash auth for bus issues
  }
}

/* --------------------------------- helpers -------------------------------- */
function isBrowser() {
  return typeof window !== "undefined" && typeof document !== "undefined";
}

function safeJSONParse(str, fallback = null) {
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

function safeJSONStringify(obj) {
  try {
    return JSON.stringify(obj);
  } catch {
    return "";
  }
}

function safeAtob(b64) {
  try {
    if (!isBrowser() || typeof atob !== "function") return null;
    return atob(b64);
  } catch {
    return null;
  }
}

function base64UrlToBase64(s) {
  return String(s).replace(/-/g, "+").replace(/_/g, "/");
}

function padBase64(s) {
  const mod = s.length % 4;
  if (!mod) return s;
  return s + "=".repeat(4 - mod);
}

function stableKind(kind) {
  return (kind || "access").toLowerCase();
}

function storageKey(kind) {
  return `ssa.auth.token.${stableKind(kind)}`;
}

function metaKey(kind) {
  return `ssa.auth.tokenMeta.${stableKind(kind)}`;
}

function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/* ---------------------------------- JWT ----------------------------------- */
/**
 * parseJwt(token)
 * - Decodes header/payload JSON if token looks like a JWT
 * - Does NOT verify signature; used for display/expiry checks only.
 */
export function parseJwt(token) {
  const t = typeof token === "string" ? token.trim() : "";
  const parts = t.split(".");
  if (parts.length < 2) return null;

  const [h, p] = parts;

  const headerRaw = safeAtob(padBase64(base64UrlToBase64(h)));
  const payloadRaw = safeAtob(padBase64(base64UrlToBase64(p)));
  if (!headerRaw || !payloadRaw) return null;

  const header = safeJSONParse(headerRaw, null);
  const payload = safeJSONParse(payloadRaw, null);
  if (!header || !payload) return null;

  return { header, payload };
}

/**
 * getTokenExpMs(token)
 * - exp claim is seconds since epoch
 */
function getTokenExpMs(token) {
  const parsed = parseJwt(token);
  const exp = parsed?.payload?.exp;
  const n = safeNum(exp, NaN);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n * 1000;
}

function isExpired(token, skewSeconds = 30) {
  const expMs = getTokenExpMs(token);
  if (!expMs) return false; // unknown exp => treat as not expired
  return Date.now() >= expMs - skewSeconds * 1000;
}

/* --------------------------- storage (safe layers) -------------------------- */
const mem = {
  tokens: new Map(), // kind -> token string
  meta: new Map(), // kind -> meta object
};

function canUseStorage(storageLike) {
  try {
    if (!isBrowser()) return false;
    if (!storageLike) return false;
    const k = "__ssa_test__" + Math.random().toString(16).slice(2);
    storageLike.setItem(k, "1");
    storageLike.removeItem(k);
    return true;
  } catch {
    return false;
  }
}

const HAS_LOCAL = canUseStorage(isBrowser() ? window.localStorage : null);
const HAS_SESSION = canUseStorage(isBrowser() ? window.sessionStorage : null);

function readFromStorage(kind) {
  const k = storageKey(kind);
  if (HAS_LOCAL) return window.localStorage.getItem(k);
  if (HAS_SESSION) return window.sessionStorage.getItem(k);
  return null;
}

function writeToStorage(kind, token) {
  const k = storageKey(kind);
  if (HAS_LOCAL) window.localStorage.setItem(k, token);
  else if (HAS_SESSION) window.sessionStorage.setItem(k, token);
}

function removeFromStorage(kind) {
  const k = storageKey(kind);
  if (HAS_LOCAL) window.localStorage.removeItem(k);
  else if (HAS_SESSION) window.sessionStorage.removeItem(k);
}

function readMetaFromStorage(kind) {
  const k = metaKey(kind);
  const raw = HAS_LOCAL
    ? window.localStorage.getItem(k)
    : HAS_SESSION
    ? window.sessionStorage.getItem(k)
    : null;
  return raw ? safeJSONParse(raw, null) : null;
}

function writeMetaToStorage(kind, meta) {
  const k = metaKey(kind);
  const raw = safeJSONStringify(meta || {});
  if (HAS_LOCAL) window.localStorage.setItem(k, raw);
  else if (HAS_SESSION) window.sessionStorage.setItem(k, raw);
}

function removeMetaFromStorage(kind) {
  const k = metaKey(kind);
  if (HAS_LOCAL) window.localStorage.removeItem(k);
  else if (HAS_SESSION) window.sessionStorage.removeItem(k);
}

/* ------------------------------ subscriptions ------------------------------ */
const listeners = new Set();

export function subscribe(fn) {
  if (typeof fn !== "function") return () => {};
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify(evt) {
  for (const fn of listeners) {
    try {
      fn(evt);
    } catch {}
  }
}

/* ------------------------------ core methods ------------------------------- */
export function getToken(kind = "access") {
  const k = stableKind(kind);

  // 1) in-memory cache
  if (mem.tokens.has(k)) return mem.tokens.get(k) || null;

  // 2) storage
  const stored = readFromStorage(k);
  if (stored) {
    mem.tokens.set(k, stored);
    return stored;
  }

  return null;
}

export function hasToken(kind = "access") {
  return !!getToken(kind);
}

export function getTokenMeta(kind = "access") {
  const k = stableKind(kind);

  if (mem.meta.has(k)) return mem.meta.get(k) || null;

  const stored = readMetaFromStorage(k);
  if (stored) {
    mem.meta.set(k, stored);
    return stored;
  }

  // Derive minimal meta if token exists
  const token = getToken(k);
  if (!token) return null;

  const expMs = getTokenExpMs(token);
  const parsed = parseJwt(token);

  const meta = {
    kind: k,
    source: "derived",
    setAtISO: null,
    expMs: expMs ?? null,
    expISO: expMs ? new Date(expMs).toISOString() : null,
    expired: expMs ? Date.now() >= expMs : false,
    claims: parsed?.payload || null,
  };

  mem.meta.set(k, meta);
  return meta;
}

/**
 * setToken(token, opts)
 * opts:
 *  - kind: "access" | "refresh" | "id" | string
 *  - persist: true (default) | false
 *  - meta: object merged into stored meta
 */
export function setToken(token, opts = {}) {
  const k = stableKind(opts.kind || "access");
  const t = typeof token === "string" ? token.trim() : "";

  if (!t) {
    clearToken(k);
    return null;
  }

  mem.tokens.set(k, t);

  const expMs = getTokenExpMs(t);
  const parsed = parseJwt(t);

  const meta = {
    kind: k,
    setAtISO: nowISO(),
    source: opts?.meta?.source || "setToken",
    expMs: expMs ?? null,
    expISO: expMs ? new Date(expMs).toISOString() : null,
    expired: expMs ? Date.now() >= expMs : false,
    claims: parsed?.payload || null,
    ...(opts?.meta && typeof opts.meta === "object" ? opts.meta : {}),
  };

  mem.meta.set(k, meta);

  const persist = opts.persist !== false; // default true
  if (persist) {
    try {
      writeToStorage(k, t);
      writeMetaToStorage(k, meta);
    } catch {
      // ignore storage failures (private mode, quota, etc.)
    }
  }

  // Emit SSA events (bus normalizes + enforces payload shape)
  busEmit("auth/token:set", { kind: k, meta });
  busEmit("auth/token:changed", { kind: k, action: "set", meta });

  notify({ type: "set", kind: k, meta });
  return t;
}

export function clearToken(kind = "access") {
  const k = stableKind(kind);

  const had = mem.tokens.has(k) || !!readFromStorage(k);

  mem.tokens.delete(k);
  mem.meta.delete(k);

  try {
    removeFromStorage(k);
    removeMetaFromStorage(k);
  } catch {}

  if (had) {
    busEmit("auth/token:cleared", { kind: k });
    busEmit("auth/token:changed", { kind: k, action: "cleared" });
    notify({ type: "cleared", kind: k });
  }

  return true;
}

export function clearAllTokens() {
  const kinds = new Set(["access", "refresh", "id"]);
  for (const k of mem.tokens.keys()) kinds.add(k);

  for (const k of kinds) clearToken(k);
  return true;
}

/* -------------------------- convenience / future --------------------------- */
/**
 * getValidToken
 * - Returns token if present and not expired (JWT exp), else null.
 * - skewSeconds: treat token as expired slightly early to avoid edge races.
 */
export function getValidToken(kind = "access", skewSeconds = 30) {
  const t = getToken(kind);
  if (!t) return null;
  if (isExpired(t, skewSeconds)) return null;
  return t;
}

/**
 * asAuthHeader
 * - Returns { Authorization: "Bearer ..." } or {} if no valid token
 */
export function asAuthHeader(kind = "access") {
  const t = getValidToken(kind);
  if (!t) return {};
  return { Authorization: `Bearer ${t}` };
}

/**
 * bootstrapFromStorage
 * - Call once at app start if you want to prime in-memory caches.
 */
export function bootstrapFromStorage(kinds = ["access", "refresh", "id"]) {
  const list = Array.isArray(kinds) ? kinds : ["access"];
  for (const kind of list) {
    const k = stableKind(kind);

    const token = readFromStorage(k);
    if (token) mem.tokens.set(k, token);

    const meta = readMetaFromStorage(k);
    if (meta) mem.meta.set(k, meta);
  }
  return true;
}

/* ------------------------------ default export ----------------------------- */
const tokenProvider = {
  SOURCE,

  // core
  getToken,
  setToken,
  clearToken,
  clearAllTokens,
  hasToken,

  // meta
  parseJwt,
  getTokenMeta,

  // helpers
  getValidToken,
  asAuthHeader,
  bootstrapFromStorage,

  // subscribe
  subscribe,
};

export default tokenProvider;
