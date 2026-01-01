// C:\Users\larho\suka-smart-assistant\src\services\scraper\ScraperCache.js
/**
 * ScraperCache — prevents re-scraping unchanged pages; stores content fingerprints
 * ---------------------------------------------------------------------------------
 * ROLE IN PIPELINE
 * imports (Scheduler/Engine) → **cache check** → fetch (maybe conditional) → normalize → automation
 * → (optional) hub export (not used here; cache does not mutate household state).
 *
 * WHAT THIS FILE DOES
 * - Maintains per-URL metadata to avoid redundant network work:
 *    • content fingerprint (FNV-1a over selected fields)
 *    • HTTP entity tags (ETag) and Last-Modified (when available)
 *    • TTL-based freshness policy (per domain/category overrides)
 *    • LRU pruning to control memory growth
 * - Produces request headers for conditional GET (If-None-Match / If-Modified-Since).
 * - Returns decisions for the scheduler/engine: "skip", "conditional", or "fetch".
 *
 * EVENTS EMITTED (payload shape: { type, ts, source, data })
 * - cache.scrape.hit            { url, policy: 'fresh' | 'stale' }
 * - cache.scrape.miss           { url, reason }
 * - cache.scrape.conditional    { url }
 * - cache.scrape.updated        { url, fingerprintChanged, etag, lastModified }
 * - cache.scrape.pruned         { removed }
 *
 * EXTENSION POINTS
 * - TTL policy map (by hostname or by tag) can be supplied via configure().
 * - Optional persistence via ImportCacheService (soft import; fails gracefully).
 *
 * DEFENSIVE DESIGN
 * - All I/O wrapped in try/catch; on failure, falls back to in-memory cache only.
 */

import eventBus from '../eventBus.js';

// Optional imports; degrade gracefully if absent
let ImportCacheService = null;
let featureFlags = { familyFundMode: false };
let HubPacketFormatter = null;
let FamilyFundConnector = null;

(async () => {
  try {
    const mod = await import('../imports/ImportCacheService.js');
    ImportCacheService = mod.default || mod;
  } catch {}
  try {
    const mod = await import('../../config/featureFlags.js');
    featureFlags = mod.default || mod || featureFlags;
  } catch {}
  try {
    const mod = await import('../../hub/HubPacketFormatter.js');
    HubPacketFormatter = mod.default || mod;
  } catch {}
  try {
    const mod = await import('../../hub/FamilyFundConnector.js');
    FamilyFundConnector = mod.default || mod;
  } catch {}
})();

/* ----------------------------------------------------------------------------
 * Utilities
 * ------------------------------------------------------------------------- */

const SOURCE = 'ScraperCache';
const nowISO = () => new Date().toISOString();
const emit = (type, data) => eventBus.emit({ type, ts: nowISO(), source: SOURCE, data });

const isStr = (v) => typeof v === 'string';
const arr = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);

// Small, fast FNV-1a hash for stable fingerprints
function fnv1a(str = '') {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

function stableJson(obj) {
  // Deterministic stringify (keys sorted)
  return JSON.stringify(obj, Object.keys(obj || {}).sort());
}

function normalizeUrl(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    // Normalize default ports
    if ((u.protocol === 'http:' && u.port === '80') || (u.protocol === 'https:' && u.port === '443')) {
      u.port = '';
    }
    return u.toString();
  } catch {
    return url;
  }
}

function hostname(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * Compute a fingerprint from a scrape payload.
 * Only uses fields that reflect meaningful content changes.
 */
export function computeFingerprint(payload = {}) {
  const basis = {
    url: normalizeUrl(payload.url || ''),
    meta: {
      title: payload.meta?.title || '',
      description: payload.meta?.description || '',
    },
    mainText: (payload.main?.text || '').replace(/\s+/g, ' ').trim().slice(0, 200000), // cap to keep hashing cheap
    tables: (arr(payload.tables) || []).map((t) => ({
      name: t.name || '',
      // use header names and a few first rows to detect schema/data changes
      columns: arr(t.columns).slice(0, 50),
      rowsHead: arr(t.rows).slice(0, 25),
    })),
    jsonldCount: arr(payload.jsonld).length,
    imagesCount: arr(payload.images).length,
    linksCount: arr(payload.links).length,
    enrichmentKind: payload.enrichment?.kind || '',
  };
  return fnv1a(stableJson(basis));
}

/**
 * Optional, reserved for future state-changing cache (not used here).
 */
async function exportToHubIfEnabled(_payload) {
  try {
    if (!featureFlags?.familyFundMode) return;
    if (!HubPacketFormatter || !FamilyFundConnector) return;
    // Cache operations are not exported today; reserved for future metrics packets.
    // const packet = HubPacketFormatter.format(payload);
    // await FamilyFundConnector.send(packet);
  } catch {
    // silent by design
  }
}

/* ----------------------------------------------------------------------------
 * In-memory LRU store (keyed by normalized URL)
 * ------------------------------------------------------------------------- */

const DEFAULT_CONFIG = Object.freeze({
  defaultTtlMs: 6 * 60 * 60 * 1000, // 6h
  maxEntries: 2000,
  // Optional per-host TTL overrides
  ttlByHost: {
    // 'example.com': 24 * 60 * 60 * 1000,
  },
  // Optional tag-based TTL overrides (e.g., 'price', 'video', 'recipe')
  ttlByTag: {
    // price: 30 * 60 * 1000,
  },
});

let _cfg = { ...DEFAULT_CONFIG };

/**
 * Entry shape:
 * {
 *   url, fingerprint, etag, lastModified, fetchedAt, ttlMs,
 *   tags: Set<string>, accessedAt, storedAt
 * }
 */
const lru = new Map(); // URL -> entry

function ttlFor(url, tags = new Set()) {
  const h = hostname(url);
  if (h && Number.isFinite(_cfg.ttlByHost?.[h])) return _cfg.ttlByHost[h];
  for (const tag of tags) {
    if (Number.isFinite(_cfg.ttlByTag?.[tag])) return _cfg.ttlByTag[tag];
  }
  return _cfg.defaultTtlMs;
}

function touch(url, entry) {
  entry.accessedAt = Date.now();
  // LRU maintenance: re-insert
  lru.delete(url);
  lru.set(url, entry);
}

function pruneIfNeeded() {
  let removed = 0;
  while (lru.size > _cfg.maxEntries) {
    const firstKey = lru.keys().next().value;
    lru.delete(firstKey);
    removed++;
  }
  if (removed) emit('cache.scrape.pruned', { removed });
  return removed;
}

/* ----------------------------------------------------------------------------
 * Public API
 * ------------------------------------------------------------------------- */

/**
 * Configure TTLs, max entries, etc.
 * @param {object} cfg
 */
export function configure(cfg = {}) {
  _cfg = {
    ..._cfg,
    ...cfg,
    ttlByHost: { ..._cfg.ttlByHost, ...(cfg.ttlByHost || {}) },
    ttlByTag: { ..._cfg.ttlByTag, ...(cfg.ttlByTag || {}) },
  };
}

/**
 * Read cache entry (in-memory; optionally fallback to ImportCacheService metadata)
 */
export async function get(url) {
  const key = normalizeUrl(url);
  const mem = lru.get(key);
  if (mem) {
    touch(key, mem);
    return { ...mem };
  }
  // Try to load metadata from ImportCacheService, if available
  try {
    if (ImportCacheService?.getMeta) {
      const meta = await ImportCacheService.getMeta(key);
      if (meta && meta.fingerprint) {
        const entry = {
          url: key,
          fingerprint: meta.fingerprint,
          etag: meta.etag,
          lastModified: meta.lastModified,
          fetchedAt: meta.fetchedAt ? new Date(meta.fetchedAt).getTime() : 0,
          ttlMs: ttlFor(key, new Set(arr(meta.tags))),
          tags: new Set(arr(meta.tags)),
          accessedAt: Date.now(),
          storedAt: Date.now(),
        };
        lru.set(key, entry);
        pruneIfNeeded();
        return { ...entry };
      }
    }
  } catch {
    // ignore persistence errors
  }
  return null;
}

/**
 * Decide whether to fetch, conditional-fetch, or skip a URL.
 * @param {string} url
 * @param {object} opts { tags?: string[] }
 * @returns {object} { decision: 'fetch'|'conditional'|'skip', headers?:{}, reason?:string }
 */
export async function shouldFetch(url, opts = {}) {
  const key = normalizeUrl(url);
  const tags = new Set(arr(opts.tags));
  const entry = await get(key);

  if (!entry) {
    emit('cache.scrape.miss', { url: key, reason: 'no-entry' });
    return { decision: 'fetch', headers: {} };
  }

  // TTL freshness check
  const age = Date.now() - (entry.fetchedAt || 0);
  const ttlMs = ttlFor(key, entry.tags.size ? entry.tags : tags);

  if (age < ttlMs) {
    emit('cache.scrape.hit', { url: key, policy: 'fresh' });
    return { decision: 'skip', reason: 'fresh' };
  }

  // Stale: attempt conditional GET if we have validators
  const headers = {};
  if (entry.etag) headers['If-None-Match'] = entry.etag;
  if (entry.lastModified) headers['If-Modified-Since'] = new Date(entry.lastModified).toUTCString();

  if (headers['If-None-Match'] || headers['If-Modified-Since']) {
    emit('cache.scrape.conditional', { url: key });
    return { decision: 'conditional', headers };
  }

  emit('cache.scrape.hit', { url: key, policy: 'stale' });
  return { decision: 'fetch', headers: {} };
}

/**
 * Prepare conditional headers even without a TTL check (utility).
 */
export async function prepareConditionalHeaders(url) {
  const entry = await get(url);
  if (!entry) return {};
  const headers = {};
  if (entry.etag) headers['If-None-Match'] = entry.etag;
  if (entry.lastModified) headers['If-Modified-Since'] = new Date(entry.lastModified).toUTCString();
  return headers;
}

/**
 * Persist cache metadata after a network result.
 * @param {string} url
 * @param {object} responseMeta { etag?, lastModified?, status?, fetchedAt? }
 * @param {object} payload optional scrape payload to compute fingerprint
 * @param {object} opts { tags?: string[] }
 *
 * NOTES:
 * - If status === 304, fingerprint does not change.
 * - If status is 2xx with payload, fingerprint recomputed.
 */
export async function noteResponse(url, responseMeta = {}, payload = null, opts = {}) {
  const key = normalizeUrl(url);
  const existing = (await get(key)) || {
    url: key,
    fingerprint: '',
    etag: undefined,
    lastModified: undefined,
    fetchedAt: 0,
    ttlMs: ttlFor(key, new Set(arr(opts.tags))),
    tags: new Set(arr(opts.tags)),
    accessedAt: Date.now(),
    storedAt: Date.now(),
  };

  let fingerprintChanged = false;

  if (responseMeta.status === 304) {
    // Not Modified: keep fingerprint
  } else if (payload) {
    const fp = computeFingerprint(payload);
    if (fp && fp !== existing.fingerprint) {
      existing.fingerprint = fp;
      fingerprintChanged = true;
    }
  }

  // Update validators and timestamps
  if (isStr(responseMeta.etag)) existing.etag = responseMeta.etag;
  if (isStr(responseMeta.lastModified) || Number.isFinite(responseMeta.lastModified)) {
    // store numeric ms
    const ms = Number(responseMeta.lastModified);
    existing.lastModified = Number.isFinite(ms) ? ms : Date.parse(responseMeta.lastModified);
  }
  existing.fetchedAt = responseMeta.fetchedAt ? Date.parse(responseMeta.fetchedAt) : Date.now();
  if (opts.tags) {
    for (const t of arr(opts.tags)) existing.tags.add(t);
  }
  existing.ttlMs = ttlFor(key, existing.tags);

  touch(key, existing);
  pruneIfNeeded();

  // Best-effort persistence of metadata
  try {
    if (ImportCacheService?.saveMeta) {
      await ImportCacheService.saveMeta(key, {
        fingerprint: existing.fingerprint,
        etag: existing.etag,
        lastModified: existing.lastModified,
        fetchedAt: new Date(existing.fetchedAt).toISOString(),
        tags: [...existing.tags],
      });
    }
  } catch {
    // ignore persistence errors
  }

  emit('cache.scrape.updated', {
    url: key,
    fingerprintChanged,
    etag: existing.etag || null,
    lastModified: existing.lastModified || null,
  });

  return { ...existing, fingerprintChanged };
}

/**
 * Convenience helper to ingest a scrape payload and store its fingerprint directly
 * (useful when the engine already fetched without conditional headers).
 */
export async function rememberPayload(payload, opts = {}) {
  if (!payload || !payload.url) return null;
  return noteResponse(
    payload.url,
    {
      status: payload.status || 200,
      etag: payload.headers?.etag || undefined,
      lastModified: payload.headers?.lastModified || undefined,
      fetchedAt: payload.fetchedAt || nowISO(),
    },
    payload,
    opts
  );
}

/**
 * Invalidate a URL (force next fetch).
 */
export async function invalidate(url) {
  const key = normalizeUrl(url);
  lru.delete(key);
  try {
    if (ImportCacheService?.deleteMeta) await ImportCacheService.deleteMeta(key);
  } catch {}
}

/**
 * Simple stats + diagnostics.
 */
export function stats() {
  const now = Date.now();
  const items = [];
  for (const [k, v] of lru.entries()) {
    items.push({
      url: k,
      ageMs: now - (v.fetchedAt || 0),
      ttlMs: v.ttlMs,
      expiresInMs: Math.max(0, v.ttlMs - (now - (v.fetchedAt || 0))),
      tags: [...(v.tags || [])],
      hasEtag: !!v.etag,
      hasLastModified: !!v.lastModified,
    });
  }
  return {
    size: lru.size,
    maxEntries: _cfg.maxEntries,
    defaultTtlMs: _cfg.defaultTtlMs,
    items,
  };
}

/* ----------------------------------------------------------------------------
 * Suggested integration (for reference):
 * - ScraperScheduler: before enqueue/fetch, call shouldFetch(url, { tags }).
 *   • decision === 'skip' → do not schedule
 *   • decision === 'conditional' → pass returned headers to ScraperEngine.scrape()
 * - ScraperEngine: after fetching, call noteResponse(url, responseMeta, payload, { tags }).
 * ------------------------------------------------------------------------- */

const ScraperCache = {
  configure,
  get,
  shouldFetch,
  prepareConditionalHeaders,
  noteResponse,
  rememberPayload,
  invalidate,
  stats,
  computeFingerprint,
};

export default ScraperCache;

/* ----------------------------------------------------------------------------
 * DEV NOTES / FUTURE
 * ------------------------------------------------------------------------- */
/**
 * - Add rolling content hash for the full HTML (behind a flag) when you need higher sensitivity.
 * - Consider a small Bloom filter to avoid duplicate scheduling bursts for the same URL.
 * - Write-through persistence: store LRU snapshot to IndexedDB/Dexie or filesystem (Node) on interval.
 * - Add per-host policy for dynamic pages (e.g., weekly-ads ttl: 30–60 min).
 * - If a future workflow mutates inventory/storehouse on scrape, then exportToHubIfEnabled()
 *   can be used to forward a slim "cache metric" packet to the Hub for observability.
 */
