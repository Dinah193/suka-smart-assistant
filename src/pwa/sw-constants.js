// src/pwa/sw-constants.js
// Single source of truth for SSA Service Worker (SW):
// - Cache names (versioned)
// - URL matchers (routes & API endpoints)
// - Background Sync tag names
// - Tiny helpers for envelopes and broadcasting
//
// How this fits the pipeline:
// imports → intelligence → automation → (optional) hub export
// • The SW supports automation/play surfaces by caching play routes and
//   buffering logs offline. Keeping constants here prevents drift across files.
//
// Notes:
// • Pure JS; no dependencies. Designed to work with bundlers or importScripts().
// • Safe to import both in SW and regular client code (helpers no-op where missing).

/* -------------------------------- Versioning ------------------------------- */

/**
 * Bump SW_VERSION to invalidate caches globally.
 * Consider tying this to your app build/version hash.
 */
const SW_VERSION = "v1.0.0";

/** Namespace for all SSA SW keys. */
const SW_NS = "ssa";

/** Build a deterministic, versioned cache name. */
function cacheName(kind) {
  return `${SW_NS}-${kind}-${SW_VERSION}`;
}

/* ---------------------------------- Caches --------------------------------- */

const CACHE = Object.freeze({
  CORE: cacheName("core"),             // app shell, critical CSS/JS
  RUNTIME: cacheName("runtime"),       // runtime-fetched assets/APIs
  PLAY_HTML: cacheName("play-html"),   // HTML for play routes
});

/* ---------------------------------- Domains -------------------------------- */

const DOMAINS = Object.freeze([
  "cooking",
  "cleaning",
  "garden",
  "animals",       // UI/route naming plural
  "animal",        // keep singular for future endpoints
  "preservation",
  "storehouse",
]);

/* --------------------------------- Routes ---------------------------------- */

/** Build a RegExp to match domain play routes: `/domain/play/*` */
function buildPlayRouteRegex(domains = DOMAINS) {
  const safe = (Array.isArray(domains) ? domains : []).map(d => String(d).replace(/[^a-z0-9]/gi, ""));
  const union = safe.length ? safe.join("|") : "cooking";
  return new RegExp(`^/(?:${union})/play(?:/.*)?$`, "i");
}

/** Canonical play-route matcher used by the SW fetch handler. */
const PLAY_ROUTE_REGEX = buildPlayRouteRegex();

/* ---------------------------------- Assets --------------------------------- */

/**
 * Default core assets to precache (override at build time).
 * Keep paths relative to the origin.
 */
const CORE_ASSETS = Object.freeze([
  "/",
  "/index.html",
  "/assets/app.css",
  "/assets/app.js",
  "/assets/vendor.js",
  "/assets/fonts/inter.woff2",
]);

/** Treat these extensions as static assets eligible for cache-first. */
const STATIC_ASSET_EXT = Object.freeze([
  "css", "js", "mjs", "jsx", "ts", "tsx",
  "woff", "woff2", "ttf", "eot",
  "png", "jpg", "jpeg", "gif", "webp", "svg",
]);

/* ----------------------------------- APIs ---------------------------------- */

/** Canonical API endpoints used by the SW. Adjust to your backend. */
const API = Object.freeze({
  PLAY_LOGS: "/api/play/logs",
  INVENTORY_SYNC: "/api/inventory/sync",  // future use
  IMPORT_WEBHOOK: "/api/import/handoff",  // future use
});

/** Utility: is this request URL an API call? */
function isApiUrl(url) {
  try {
    const u = new URL(url, self.location?.origin || undefined);
    return u.pathname.startsWith("/api/");
  } catch {
    return false;
  }
}

/* ------------------------------- BG Sync tags ------------------------------ */

/** Background Sync tags (use sparingly; iOS Safari lacks Sync support). */
const SYNC_TAG = Object.freeze({
  PLAY_LOGS: "ssa-playlog-sync",
  INVENTORY: "ssa-inventory-sync",   // reserved for future use
  IMPORTS: "ssa-imports-sync",       // reserved for future use
});

/* --------------------------------- Helpers --------------------------------- */

/** ISO timestamp (kept here so SW & clients emit same shape). */
function nowIso() {
  return new Date().toISOString();
}

/** Build an SSA-style envelope for postMessage telemetry. */
function envelope(type, data = {}) {
  return { type, ts: nowIso(), source: "pwa.sw.constants", data };
}

/**
 * Broadcast an envelope to all window clients.
 * Safe to call from Service Worker; in non-SW contexts it no-ops.
 */
async function broadcastToAllClients(type, data = {}) {
  if (typeof self === "undefined" || !self.clients || !self.clients.matchAll) return;
  const list = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const msg = envelope(type, data);
  list.forEach(c => {
    try { c.postMessage(msg); } catch { /* no-op */ }
  });
}

/** Is this request likely an HTML navigation (good for SPA route handling)? */
function isHtmlRequest(req) {
  try {
    const accept = req.headers && req.headers.get && req.headers.get("accept");
    return !!accept && accept.includes("text/html");
  } catch {
    return false;
  }
}

/** Is this a path that looks like a static asset? */
function isStaticAssetPath(pathname = "") {
  const m = pathname.match(/\.([a-z0-9]+)$/i);
  if (!m) return false;
  const ext = m[1].toLowerCase();
  return STATIC_ASSET_EXT.includes(ext);
}

/* ---------------------------------- Export --------------------------------- */

// UMD-ish: support CommonJS (bundlers) and attach to self for importScripts()
const exported = {
  SW_VERSION,
  SW_NS,
  CACHE,
  DOMAINS,
  PLAY_ROUTE_REGEX,
  buildPlayRouteRegex,
  CORE_ASSETS,
  STATIC_ASSET_EXT,
  API,
  SYNC_TAG,
  // helpers
  cacheName,
  isApiUrl,
  isHtmlRequest,
  isStaticAssetPath,
  nowIso,
  envelope,
  broadcastToAllClients,
};

try {
  // CommonJS / bundlers
  if (typeof module !== "undefined" && module.exports) {
    module.exports = exported;
  }
  // ESM (some bundlers will rewrite)
  // export default exported; // (commented to preserve single-file compatibility)
  // Global attach for importScripts()
  if (typeof self !== "undefined") {
    self.SSA_SW_CONSTANTS = exported;
  }
} catch {
  // best-effort only
}

/* --------------------------------- Usage -----------------------------------
In your Service Worker (ESM or classic):

// If bundling:
import {
  SW_VERSION, CACHE, PLAY_ROUTE_REGEX, CORE_ASSETS, API, SYNC_TAG,
  isApiUrl, isHtmlRequest, isStaticAssetPath, envelope, broadcastToAllClients
} from "./sw-constants";

// If using importScripts():
importScripts("/src/pwa/sw-constants.js");
const {
  SW_VERSION, CACHE, PLAY_ROUTE_REGEX, CORE_ASSETS, API, SYNC_TAG,
  isApiUrl, isHtmlRequest, isStaticAssetPath, envelope, broadcastToAllClients
} = self.SSA_SW_CONSTANTS;

----------------------------------------------------------------------------- */
