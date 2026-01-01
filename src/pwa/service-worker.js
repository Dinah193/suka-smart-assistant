/* src/pwa/service-worker.js
 * Suka Smart Assistant (SSA) — PWA Service Worker
 *
 * How this fits the pipeline:
 * imports → intelligence → automation → (optional) hub export
 * • This SW improves UX for the automation/overlay "play" surfaces by caching the
 *   play routes and core assets so live sessions keep rendering even if the network blips.
 * • It also provides an offline queue for play logs (observability/telemetry) so
 *   session history is consistent even if connectivity is intermittent.
 *
 * Notes:
 * • Pure browser APIs; no external libs. Defensive and forward-thinking.
 * • Emits SSA-style client messages: { type, ts, source, data } to all clients.
 */

/* ------------------------------- Constants -------------------------------- */

const SW_SRC = "pwa.service-worker";
const VERSION = "v1.0.0";
const CORE_CACHE = `ssa-core-${VERSION}`;
const RUNTIME_CACHE = `ssa-runtime-${VERSION}`;
const PLAY_HTML_CACHE = `ssa-play-html-${VERSION}`;
const LOG_QUEUE_DB = "ssa-playlog-queue";
const LOG_QUEUE_STORE = "queue";

/** Precachable core assets (fingerprinted by your build). Update at build time. */
const CORE_ASSETS = [
  "/",                             // app shell (if applicable)
  "/index.html",                   // optional if SPA shell exists
  "/assets/app.css",
  "/assets/app.js",
  "/assets/vendor.js",
  "/assets/fonts/inter.woff2",
];

/** Paths to cache for play UIs (HTML/JS/CSS and runtime JSON). */
const PLAY_ROUTE_REGEX = /^\/(cooking|cleaning|garden|animals)\/play\/?.*/;

/** API endpoint for play logs (POST). Change if your API path differs. */
const PLAY_LOG_ENDPOINT = "/api/play/logs";

/** Background Sync tag for play log delivery. */
const PLAY_SYNC_TAG = "ssa-playlog-sync";

/** Queue tuning */
const QUEUE_MAX = 200;                 // cap total queued log requests
const RETRY_BASE_MS = 1000;            // base backoff (1s)
const RETRY_MAX_MS = 60 * 1000;        // max backoff (60s)

/* ------------------------------- Utilities -------------------------------- */

function nowIso() {
  return new Date().toISOString();
}

function envelope(type, data) {
  return { type, ts: nowIso(), source: SW_SRC, data };
}

async function broadcastToAllClients(type, data = {}) {
  const clientsList = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  clientsList.forEach(c => c.postMessage(envelope(type, data)));
}

function isHtmlRequest(req) {
  const accept = req.headers.get("accept") || "";
  return accept.includes("text/html");
}

function isApiRequest(req) {
  return req.url.includes("/api/");
}

function timeout(ms) {
  return new Promise(res => setTimeout(res, ms));
}

function backoffDelay(attempt) {
  const exp = Math.min(RETTRY_MAX_POW, attempt);
  const cap = Math.min(RETRY_BASE_MS * Math.pow(2, exp), RETRY_MAX_MS);
  return Math.floor(Math.random() * cap);
}
const RETTRY_MAX_POW = 10;

/* ------------------------------- IndexedDB -------------------------------- */

/** Minimal IndexedDB helper (no deps). */
const idb = {
  async withStore(mode, fn) {
    const db = await idb.open();
    const tx = db.transaction(LOG_QUEUE_STORE, mode);
    const store = tx.objectStore(LOG_QUEUE_STORE);
    const result = await fn(store);
    await tx.done;
    return result;
  },
  open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(LOG_QUEUE_DB, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(LOG_QUEUE_STORE)) {
          db.createObjectStore(LOG_QUEUE_STORE, { keyPath: "id", autoIncrement: true });
        }
      };
      req.onsuccess = () => resolve(wrapDb(req.result));
      req.onerror = () => reject(req.error);
    });
  },
};

function wrapDb(db) {
  return {
    transaction(storeName, mode) {
      const tx = db.transaction(storeName, mode);
      return {
        objectStore(name) {
          return tx.objectStore(name);
        },
        done: new Promise((resolve, reject) => {
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
          tx.onabort = () => reject(tx.error);
        }),
      };
    },
    close() { try { db.close(); } catch {} },
  };
}

/* Queue operations */
async function queueSize() {
  return idb.withStore("readonly", store => count(store));
}

async function count(store) {
  return new Promise((resolve, reject) => {
    const req = store.count();
    req.onsuccess = () => resolve(req.result || 0);
    req.onerror = () => reject(req.error);
  });
}

async function enqueueLog(record) {
  return idb.withStore("readwrite", async store => {
    const size = await new Promise((resolve, reject) => {
      const rc = store.count();
      rc.onsuccess = () => resolve(rc.result || 0);
      rc.onerror = () => reject(rc.error);
    });
    // Drop oldest if at capacity
    if (size >= QUEUE_MAX) {
      await deleteOldest(store);
      await broadcastToAllClients("sw.queue.drop", { reason: "capacity", store: LOG_QUEUE_STORE });
    }
    return new Promise((resolve, reject) => {
      const req = store.add({ ...record, enqueuedAt: nowIso(), attempts: 0 });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  });
}

async function deleteOldest(store) {
  return new Promise((resolve, reject) => {
    const cursorReq = store.openCursor();
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (cursor) {
        store.delete(cursor.primaryKey).onsuccess = () => resolve(true);
      } else {
        resolve(false);
      }
    };
    cursorReq.onerror = () => reject(cursorReq.error);
  });
}

async function peekOldest() {
  return idb.withStore("readwrite", store => new Promise((resolve, reject) => {
    const cursorReq = store.openCursor();
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (cursor) {
        resolve({ key: cursor.primaryKey, value: cursor.value });
      } else {
        resolve(null);
      }
    };
    cursorReq.onerror = () => reject(cursorReq.error);
  }));
}

async function updateRecord(key, updater) {
  return idb.withStore("readwrite", store => new Promise((resolve, reject) => {
    const getReq = store.get(key);
    getReq.onsuccess = () => {
      const val = getReq.result;
      if (!val) return resolve(false);
      const next = updater(val) || val;
      const putReq = store.put(next);
      putReq.onsuccess = () => resolve(true);
      putReq.onerror = () => reject(putReq.error);
    };
    getReq.onerror = () => reject(getReq.error);
  }));
}

async function removeRecord(key) {
  return idb.withStore("readwrite", store => new Promise((resolve, reject) => {
    const delReq = store.delete(key);
    delReq.onsuccess = () => resolve(true);
    delReq.onerror = () => reject(delReq.error);
  }));
}

/* ------------------------------- Install/Activate ------------------------------- */

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    // Cache core shell
    const cache = await caches.open(CORE_CACHE);
    await cache.addAll(CORE_ASSETS.filter(Boolean));
    await self.skipWaiting();
    await broadcastToAllClients("sw.install", { version: VERSION });
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    // Claim clients immediately
    await self.clients.claim();

    // Clean up old caches
    const keys = await caches.keys();
    const keep = new Set([CORE_CACHE, RUNTIME_CACHE, PLAY_HTML_CACHE]);
    await Promise.all(keys.filter(k => !keep.has(k)).map(k => caches.delete(k)));

    await broadcastToAllClients("sw.activate", { version: VERSION });
  })());
});

/* ----------------------------------- Fetch ----------------------------------- */

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Background queue: intercept play logs (POST to /api/play/logs)
  if (url.pathname === PLAY_LOG_ENDPOINT && req.method === "POST") {
    return event.respondWith(handlePlayLogPost(event));
  }

  // Cache HTML for play routes with Network-First (so we get fresh during good network)
  if (req.method === "GET" && PLAY_ROUTE_REGEX.test(url.pathname) && isHtmlRequest(req)) {
    return event.respondWith(networkFirstHtml(req));
  }

  // Assets: CSS/JS/fonts/images — Cache-First with revalidate for runtime assets
  if (req.method === "GET" && isStaticAsset(url.pathname)) {
    return event.respondWith(cacheFirst(req));
  }

  // APIs (non-log): Network-First with fallback to cache (if any)
  if (req.method === "GET" && isApiRequest(req)) {
    return event.respondWith(networkFirstApi(req));
  }

  // Default: pass through
});

/* ------------------------------- Caching impl ------------------------------- */

async function networkFirstHtml(req) {
  try {
    const res = await fetch(req);
    const cache = await caches.open(PLAY_HTML_CACHE);
    cache.put(req, res.clone());
    return res;
  } catch {
    const cached = await caches.match(req);
    if (cached) return cached;
    // Fallback to shell for SPA routes
    return caches.match("/index.html") || new Response("Offline", { status: 503 });
  }
}

async function cacheFirst(req) {
  const cached = await caches.match(req);
  if (cached) return cached;
  try {
    const res = await fetch(req);
    const cache = await caches.open(RUNTIME_CACHE);
    cache.put(req, res.clone());
    return res;
  } catch {
    return new Response("", { status: 504 });
  }
}

async function networkFirstApi(req) {
  try {
    const res = await fetch(req);
    const cache = await caches.open(RUNTIME_CACHE);
    cache.put(req, res.clone());
    return res;
  } catch {
    const cached = await caches.match(req);
    if (cached) return cached;
    return new Response(JSON.stringify({ error: "offline" }), { status: 503, headers: { "Content-Type": "application/json" } });
  }
}

function isStaticAsset(pathname) {
  return /\.(?:css|js|mjs|ts|tsx|jsx|woff2?|ttf|eot|png|jpg|jpeg|gif|webp|svg)$/.test(pathname);
}

/* ----------------------------- Play log queueing ----------------------------- */

/**
 * Handle POST /api/play/logs
 * Network available → pass through
 * Offline/failed → enqueue and return 202 Accepted
 */
async function handlePlayLogPost(event) {
  const req = event.request;

  // Clone the request body safely (works for JSON logs)
  const body = await safeReadJson(req.clone());

  // Try network path first
  try {
    const res = await fetch(req.clone());
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    // Success — notify clients
    broadcastToAllClients("sw.playlog.sent", { ok: true });
    return res;
  } catch (err) {
    // Enqueue and schedule sync
    await enqueueLog({ url: PLAY_LOG_ENDPOINT, body, headers: extractHeaders(req), method: "POST" });
    try { await self.registration.sync.register(PLAY_SYNC_TAG); } catch { /* Safari/iOS lacks Sync */ }
    broadcastToAllClients("sw.playlog.enqueued", { size: await queueSize() });
    // Respond Accepted to keep the UI snappy
    return new Response(JSON.stringify({ queued: true }), {
      status: 202,
      headers: { "Content-Type": "application/json" },
    });
  }
}

/* -------------------------------- Background Sync -------------------------------- */

self.addEventListener("sync", (event) => {
  if (event.tag === PLAY_SYNC_TAG) {
    event.waitUntil(flushPlayLogQueue());
  }
});

// Also try when connection returns
self.addEventListener("online", () => flushPlayLogQueue());

async function flushPlayLogQueue() {
  let attempt = 0;
  let sent = 0;
  while (true) {
    const item = await peekOldest();
    if (!item) break; // done
    const { key, value } = item;
    const ok = await trySendOnce(value);
    if (ok) {
      await removeRecord(key);
      sent++;
      continue;
    }
    // Failed: backoff and bump attempts
    await updateRecord(key, (rec) => ({ ...rec, attempts: (rec.attempts || 0) + 1, lastErrorAt: nowIso() }));
    attempt++;
    // Short exponential backoff before next try
    await timeout(backoffDelay(attempt));
    // Optionally break if repeated failures (we keep it tolerant)
    if (attempt > 20) break;
  }
  if (sent > 0) {
    broadcastToAllClients("sw.playlog.flush.success", { sent });
  }
  return sent;
}

async function trySendOnce(entry) {
  const { url, body, headers, method } = entry || {};
  if (!url || method !== "POST") return true; // nothing to do
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: headers || { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return true;
  } catch (err) {
    await broadcastToAllClients("sw.playlog.flush.error", { message: err?.message || String(err) });
    return false;
  }
}

/* --------------------------------- Messaging --------------------------------- */

/**
 * Clients can postMessage commands:
 * { cmd: "flushPlayLogs" }              → force flush
 * { cmd: "queuePlayLog", body, headers} → enqueue manually (used by older pages)
 * { cmd: "ping" }                       → respond with pong
 */
self.addEventListener("message", (event) => {
  const msg = event.data || {};
  if (!msg || typeof msg !== "object") return;

  switch (msg.cmd) {
    case "flushPlayLogs":
      event.waitUntil((async () => {
        const sent = await flushPlayLogQueue();
        event.source && event.source.postMessage(envelope("sw.flushPlayLogs.done", { sent }));
      })());
      break;

    case "queuePlayLog":
      event.waitUntil((async () => {
        await enqueueLog({
          url: PLAY_LOG_ENDPOINT,
          method: "POST",
          headers: normalizeHeaders(msg.headers),
          body: msg.body || {},
        });
        try { await self.registration.sync.register(PLAY_SYNC_TAG); } catch {}
        event.source && event.source.postMessage(envelope("sw.queuePlayLog.queued", { size: await queueSize() }));
      })());
      break;

    case "ping":
      event.source && event.source.postMessage(envelope("sw.pong", { version: VERSION }));
      break;

    default:
      // no-op
      break;
  }
});

/* --------------------------------- Helpers --------------------------------- */

async function safeReadJson(req) {
  try {
    const text = await req.text();
    if (!text) return {};
    return JSON.parse(text);
  } catch { return {}; }
}

function extractHeaders(req) {
  const h = {};
  req.headers.forEach((v, k) => {
    // Only forward safe headers
    if (/^content-type$|^authorization$|^x-/.test(k)) h[k] = v;
  });
  if (!h["content-type"]) h["content-type"] = "application/json";
  return h;
}

function normalizeHeaders(obj) {
  if (!obj || typeof obj !== "object") return { "Content-Type": "application/json" };
  const out = {};
  Object.keys(obj).forEach(k => { out[k.toLowerCase()] = obj[k]; });
  if (!out["content-type"]) out["content-type"] = "application/json";
  return out;
}

/* ----------------------------- Version handshake ----------------------------- */

// Let newly activated SW tell pages its version and readiness.
broadcastToAllClients("sw.ready", { version: VERSION }).catch(() => { /* first load */ });
