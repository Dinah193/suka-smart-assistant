/**
 * @file src/agents/cache/memo.js
 *
 * Memoization and caching logic for Suka Smart Assistant (SSA).
 *
 * HOW THIS FITS:
 * - Central cache helper for SSA agents and Reasoner wrappers:
 *   - Avoids recomputing expensive Reasoner calls for the same
 *     (domain, intent, input) within a TTL window.
 *   - Provides a small in-memory LRU cache for fast hits.
 *   - Optional pluggable storage adapter (e.g., Dexie, localStorage,
 *     IndexedDB) for persistence across page reloads.
 *   - Emits cache telemetry via eventBus for observability.
 *
 * TYPICAL USAGE:
 * ```js
 * import { memoizeAsync } from '../../agents/cache/memo';
 *
 * // Wrap an expensive Reasoner call:
 * const runSessionComposer = memoizeAsync(
 *   async (input) => {
 *     // ...call Reasoner / heavy logic...
 *     return result;
 *   },
 *   {
 *     domain: 'sessions',
 *     intent: 'session.compose.cooking',
 *     ttlMs: 10 * 60 * 1000 // 10 minutes
 *   }
 * );
 *
 * // Later in a route or agent:
 * const result = await runSessionComposer({ recipeId, servings });
 * ```
 */

import { emit } from "../../services/events/eventBus";

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Cache key parts (logical identifiers).
 *
 * @typedef {Object} MemoKeyParts
 * @property {string} domain     SSA domain, e.g. 'sessions', 'imports'
 * @property {string} intent     Intent key, e.g. 'session.compose.cooking'
 * @property {string} [variant]  Optional variant (e.g., 'v1', 'lowPower')
 * @property {string} [userId]   Optional user identifier (hashed / anonymized)
 * @property {string} [fingerprint] Optional environmental fingerprint
 */

/**
 * Stored cache entry.
 *
 * @typedef {Object} MemoEntry
 * @property {string} key              Canonical cache key string
 * @property {any} value               Cached value
 * @property {number} createdAt        Epoch ms when entry was created
 * @property {number|null} expiresAt   Epoch ms when entry becomes stale
 * @property {Object} meta
 * @property {MemoKeyParts} meta.keyParts
 * @property {number} [meta.ttlMs]
 * @property {number} [meta.hitCount]
 * @property {string} [meta.version]   Optional semantic version for schema changes
 */

/**
 * Configuration for setting / memoizing values.
 *
 * @typedef {Object} MemoOptions
 * @property {number} [ttlMs]                  Time-to-live in ms; default: MEMO_DEFAULT_TTL_MS
 * @property {string} [version]                Optional schema/version tag
 * @property {boolean} [skipStorage]           If true, only in-memory cache is used
 * @property {boolean} [allowStaleWhileRevalidate]
 *           If true, stale entries can be returned as a "soft hit" while caller re-computes.
 */

/**
 * Storage adapter interface (optional, pluggable).
 *
 * @typedef {Object} MemoStorageAdapter
 * @property {(key: string) => Promise<MemoEntry|null>} get
 * @property {(entry: MemoEntry) => Promise<void>} set
 * @property {(key: string) => Promise<void>} remove
 * @property {() => Promise<void>} clear
 */

/* -------------------------------------------------------------------------- */
/*  Constants                                                                 */
/* -------------------------------------------------------------------------- */

const MEMO_DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MEMO_MAX_ENTRIES = 200; // per tab / in-memory

/**
 * In-memory LRU cache: Map preserves insertion order (oldest → newest).
 * Key: string  |  Value: MemoEntry
 *
 * We treat this as a per-tab cache. Persistent storage (if configured)
 * is handled via `storageAdapter`.
 *
 * @type {Map<string, MemoEntry>}
 */
const memoryCache = new Map();

/**
 * Optional pluggable storage adapter. You can set this from your app
 * bootstrap, for example with a Dexie-backed implementation.
 *
 * Example (in a setup file):
 * ```js
 * import { setMemoStorageAdapter } from 'src/agents/cache/memo';
 * import { sessionsMemoStorage } from 'src/services/db/sessionsMemoStorage';
 *
 * setMemoStorageAdapter(sessionsMemoStorage);
 * ```
 *
 * @type {MemoStorageAdapter|null}
 */
let storageAdapter = null;

/* -------------------------------------------------------------------------- */
/*  Storage adapter registration                                              */
/* -------------------------------------------------------------------------- */

/**
 * Register a persistent storage adapter (Dexie, localStorage wrapper, etc.).
 *
 * @param {MemoStorageAdapter|null} adapter
 */
export function setMemoStorageAdapter(adapter) {
  storageAdapter = adapter || null;
}

/* -------------------------------------------------------------------------- */
/*  Key utilities                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Build a deterministic cache key from logical parts and an input payload.
 *
 * The input payload is JSON-stringified in a stable way (keys sorted)
 * to avoid accidental cache misses from key order differences.
 *
 * @param {MemoKeyParts} parts
 * @param {any} inputPayload
 * @returns {string}
 */
export function buildMemoKey(parts, inputPayload) {
  const {
    domain,
    intent,
    variant = "default",
    userId = "anon",
    fingerprint = "",
  } = parts || {};

  const safeDomain =
    typeof domain === "string" && domain.trim() ? domain.trim() : "unknown";
  const safeIntent =
    typeof intent === "string" && intent.trim() ? intent.trim() : "unknown";

  const payload = stableStringify(inputPayload);

  // Format:
  //   domain:intent:variant:userId:fingerprint|payloadHash
  const payloadHash = simpleHash(payload);

  return `${safeDomain}:${safeIntent}:${variant}:${userId}:${fingerprint}|${payloadHash}`;
}

/**
 * Stable-ish JSON stringify: sorts object keys to avoid key-order mismatches.
 *
 * @param {any} value
 * @returns {string}
 */
function stableStringify(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return "[" + value.map((v) => stableStringify(v)).join(",") + "]";
  }

  const keys = Object.keys(value).sort();
  const pairs = keys.map(
    (k) => JSON.stringify(k) + ":" + stableStringify(value[k])
  );
  return "{" + pairs.join(",") + "}";
}

/**
 * Simple non-cryptographic hash for payload keys.
 *
 * @param {string} str
 * @returns {string}
 */
function simpleHash(str) {
  let hash = 0;
  if (!str || typeof str !== "string") return "0";
  for (let i = 0; i < str.length; i++) {
    // 31-based hash
    hash = (hash * 31 + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36);
}

/* -------------------------------------------------------------------------- */
/*  Core cache operations                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Get a memoized value by key parts + payload.
 *
 * - Checks in-memory LRU cache first.
 * - Fallbacks to storageAdapter (if configured and not skipStorage).
 * - Handles TTL: expired entries are treated as misses and removed.
 *
 * @param {MemoKeyParts} parts
 * @param {any} inputPayload
 * @param {MemoOptions} [options]
 * @returns {Promise<{ hit: boolean, stale: boolean, entry: MemoEntry|null }>}
 */
export async function getMemo(parts, inputPayload, options = {}) {
  const key = buildMemoKey(parts, inputPayload);
  const now = Date.now();
  const allowStale = !!options.allowStaleWhileRevalidate;

  // 1) In-memory check
  const memEntry = memoryCache.get(key);
  if (memEntry) {
    const expired = memEntry.expiresAt != null && memEntry.expiresAt <= now;

    if (!expired) {
      // LRU bump: re-insert to mark as most recently used
      memoryCache.delete(key);
      memoryCache.set(key, memEntry);

      safeEmitCacheHit(key, parts, false);
      return { hit: true, stale: false, entry: memEntry };
    }

    // Expired in memory
    memoryCache.delete(key);
    safeEmitCacheMiss(key, parts, "expired-memory");

    if (!allowStale) {
      return { hit: false, stale: false, entry: null };
    }

    // Stale-while-revalidate: return entry but mark stale
    safeEmitCacheHit(key, parts, true);
    return { hit: true, stale: true, entry: memEntry };
  }

  // 2) Persistent storage (if available and not skipped)
  if (
    !options.skipStorage &&
    storageAdapter &&
    typeof storageAdapter.get === "function"
  ) {
    try {
      const stored = await storageAdapter.get(key);
      if (!stored) {
        safeEmitCacheMiss(key, parts, "not-found-storage");
        return { hit: false, stale: false, entry: null };
      }

      const expired = stored.expiresAt != null && stored.expiresAt <= now;

      if (!expired) {
        // Inject into in-memory LRU
        memoryCache.set(key, stored);
        enforceMemoryLimit();
        safeEmitCacheHit(key, parts, false);
        return { hit: true, stale: false, entry: stored };
      }

      // Expired in storage
      safeEmitCacheMiss(key, parts, "expired-storage");
      try {
        await storageAdapter.remove(key);
      } catch {
        // best-effort
      }

      if (!allowStale) {
        return { hit: false, stale: false, entry: null };
      }

      safeEmitCacheHit(key, parts, true);
      return { hit: true, stale: true, entry: stored };
    } catch (err) {
      safeEmitCacheError(key, parts, "storage-get-error", err);
      return { hit: false, stale: false, entry: null };
    }
  }

  // Miss
  safeEmitCacheMiss(key, parts, "not-found");
  return { hit: false, stale: false, entry: null };
}

/**
 * Store a value in cache for a given key + payload.
 *
 * - Writes to in-memory LRU.
 * - Optionally persists via storageAdapter.
 *
 * @param {MemoKeyParts} parts
 * @param {any} inputPayload
 * @param {any} value
 * @param {MemoOptions} [options]
 * @returns {Promise<MemoEntry>}
 */
export async function setMemo(parts, inputPayload, value, options = {}) {
  const key = buildMemoKey(parts, inputPayload);
  const now = Date.now();
  const ttlMs =
    typeof options.ttlMs === "number" && options.ttlMs > 0
      ? options.ttlMs
      : MEMO_DEFAULT_TTL_MS;

  /** @type {MemoEntry} */
  const entry = {
    key,
    value,
    createdAt: now,
    expiresAt: now + ttlMs,
    meta: {
      keyParts: parts,
      ttlMs,
      hitCount: 0,
      version: options.version || "1.0.0",
    },
  };

  // Write to in-memory LRU
  memoryCache.set(key, entry);
  enforceMemoryLimit();

  // Persist if adapter available and not skipped
  if (
    !options.skipStorage &&
    storageAdapter &&
    typeof storageAdapter.set === "function"
  ) {
    try {
      await storageAdapter.set(entry);
    } catch (err) {
      safeEmitCacheError(key, parts, "storage-set-error", err);
    }
  }

  safeEmitCacheSet(key, parts, ttlMs);
  return entry;
}

/**
 * Back-compat alias expected by some shims.
 *
 * preservationShim.js imports:
 *   import { maybeGetCached, updateCache } from "@/agents/cache/memo";
 *
 * Keep canonical implementation as getMemo/setMemo and provide these aliases.
 *
 * @param {MemoKeyParts} parts
 * @param {any} inputPayload
 * @param {MemoOptions} [options]
 * @returns {Promise<{ hit: boolean, stale: boolean, entry: MemoEntry|null }>}
 */
export async function maybeGetCached(parts, inputPayload, options = {}) {
  return getMemo(parts, inputPayload, options);
}

/**
 * Back-compat alias expected by some shims.
 *
 * @param {MemoKeyParts} parts
 * @param {any} inputPayload
 * @param {any} value
 * @param {MemoOptions} [options]
 * @returns {Promise<MemoEntry>}
 */
export async function updateCache(parts, inputPayload, value, options = {}) {
  return setMemo(parts, inputPayload, value, options);
}

/**
 * Clear a specific memo entry for a given key+payload.
 *
 * @param {MemoKeyParts} parts
 * @param {any} inputPayload
 * @returns {Promise<void>}
 */
export async function clearMemo(parts, inputPayload) {
  const key = buildMemoKey(parts, inputPayload);
  memoryCache.delete(key);

  if (storageAdapter && typeof storageAdapter.remove === "function") {
    try {
      await storageAdapter.remove(key);
    } catch (err) {
      safeEmitCacheError(key, parts, "storage-remove-error", err);
    }
  }

  safeEmitCacheEvict(key, parts, "manual-clear");
}

/**
 * Clear all memo entries (in-memory + persistent storage).
 *
 * Use with care: this is a global cache flush.
 *
 * @returns {Promise<void>}
 */
export async function clearAllMemo() {
  memoryCache.clear();

  if (storageAdapter && typeof storageAdapter.clear === "function") {
    try {
      await storageAdapter.clear();
    } catch (err) {
      safeEmitCacheError(
        "*",
        { domain: "*", intent: "*", variant: "all" },
        "storage-clear-error",
        err
      );
    }
  }

  safeEmitCacheEvict(
    "*",
    { domain: "*", intent: "*", variant: "all" },
    "clear-all"
  );
}

/**
 * Enforce LRU memory limit by evicting the oldest entries.
 */
function enforceMemoryLimit() {
  while (memoryCache.size > MEMO_MAX_ENTRIES) {
    const oldestKey = memoryCache.keys().next().value;
    const oldestEntry = memoryCache.get(oldestKey);
    memoryCache.delete(oldestKey);
    if (oldestEntry && oldestEntry.meta && oldestEntry.meta.keyParts) {
      safeEmitCacheEvict(oldestKey, oldestEntry.meta.keyParts, "lru-evict");
    } else {
      safeEmitCacheEvict(
        oldestKey,
        { domain: "unknown", intent: "unknown" },
        "lru-evict"
      );
    }
  }
}

/* -------------------------------------------------------------------------- */
/*  memoizeAsync helper                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Wrap an async function with memoization.
 *
 * - Automatically builds cache keys from (parts, args) using stable JSON.
 * - Respects TTL and storageAdapter.
 * - Can use stale-while-revalidate semantics (caller decides whether to
 *   re-compute when `result.stale === true` if they call `getMemo` directly).
 *
 * NOTE:
 * - This helper returns *only the value*, not the full MemoEntry.
 * - Errors from the wrapped fn are *not* cached.
 *
 * @template TArgs
 * @template TResult
 * @param {( ...args: any[] ) => Promise<TResult>} fn
 * @param {MemoKeyParts & MemoOptions & {
 *   keyFromArgs?: (...args: any[]) => any
 * }} config
 * @returns {( ...args: any[] ) => Promise<TResult>}
 */
export function memoizeAsync(fn, config) {
  if (typeof fn !== "function") {
    throw new Error("memoizeAsync: fn must be a function");
  }

  const {
    keyFromArgs,
    ttlMs,
    version,
    skipStorage,
    allowStaleWhileRevalidate,
    ...parts
  } = config || {};

  return async function memoizedFn(...args) {
    const payload =
      typeof keyFromArgs === "function" ? keyFromArgs(...args) : args;

    // 1) Try cache
    const { hit, stale, entry } = await getMemo(parts, payload, {
      ttlMs,
      version,
      skipStorage,
      allowStaleWhileRevalidate,
    });

    if (hit && entry && !stale) {
      // Increment hit count (in memory)
      if (entry.meta && typeof entry.meta.hitCount === "number") {
        entry.meta.hitCount += 1;
      }
      return entry.value;
    }

    // 2) Compute fresh value
    const value = await fn(...args);

    // If stale-while-revalidate was used, the caller might not need to
    // re-set the cache, but we generally do so to refresh TTL.
    await setMemo(parts, payload, value, {
      ttlMs,
      version,
      skipStorage,
      allowStaleWhileRevalidate,
    });

    return value;
  };
}

/* -------------------------------------------------------------------------- */
/*  Telemetry                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Emit a cache hit event.
 *
 * @param {string} key
 * @param {MemoKeyParts} parts
 * @param {boolean} stale
 */
function safeEmitCacheHit(key, parts, stale) {
  try {
    if (typeof emit !== "function") return;
    emit({
      type: "memo.cache.hit",
      ts: new Date().toISOString(),
      source: "agents.cache.memo",
      data: {
        key,
        parts,
        stale,
      },
    });
  } catch {
    // Never break caller on telemetry issues.
  }
}

/**
 * Emit a cache miss event.
 *
 * @param {string} key
 * @param {MemoKeyParts} parts
 * @param {string} reason
 */
function safeEmitCacheMiss(key, parts, reason) {
  try {
    if (typeof emit !== "function") return;
    emit({
      type: "memo.cache.miss",
      ts: new Date().toISOString(),
      source: "agents.cache.memo",
      data: {
        key,
        parts,
        reason,
      },
    });
  } catch {
    // Swallow telemetry errors.
  }
}

/**
 * Emit a cache set event.
 *
 * @param {string} key
 * @param {MemoKeyParts} parts
 * @param {number} ttlMs
 */
function safeEmitCacheSet(key, parts, ttlMs) {
  try {
    if (typeof emit !== "function") return;
    emit({
      type: "memo.cache.set",
      ts: new Date().toISOString(),
      source: "agents.cache.memo",
      data: {
        key,
        parts,
        ttlMs,
      },
    });
  } catch {
    // Swallow telemetry errors.
  }
}

/**
 * Emit a cache eviction event.
 *
 * @param {string} key
 * @param {MemoKeyParts} parts
 * @param {string} reason
 */
function safeEmitCacheEvict(key, parts, reason) {
  try {
    if (typeof emit !== "function") return;
    emit({
      type: "memo.cache.evict",
      ts: new Date().toISOString(),
      source: "agents.cache.memo",
      data: {
        key,
        parts,
        reason,
      },
    });
  } catch {
    // Swallow telemetry errors.
  }
}

/**
 * Emit a cache error event (non-fatal).
 *
 * @param {string} key
 * @param {MemoKeyParts} parts
 * @param {string} code
 * @param {any} err
 */
function safeEmitCacheError(key, parts, code, err) {
  try {
    if (typeof emit !== "function") return;
    emit({
      type: "memo.cache.error",
      ts: new Date().toISOString(),
      source: "agents.cache.memo",
      data: {
        key,
        parts,
        code,
        error: String(err),
      },
    });
  } catch {
    // Swallow telemetry errors.
  }
}

export default {
  setMemoStorageAdapter,
  buildMemoKey,
  getMemo,
  setMemo,
  maybeGetCached,
  updateCache,
  clearMemo,
  clearAllMemo,
  memoizeAsync,
};
