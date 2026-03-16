// File: src/agents/runtime/reasoner/cache/memo.js
// SSA Reasoner Cache Memo (Dexie-first, memory fallback)
//
// Purpose
// - Provide a tiny memoization layer for shims calling the Reasoner.
// - Default behavior: use Dexie if available (preferred for persistence/offline).
// - Fallback: in-memory Map (works during early bootstrap / tests).
//
// Expected usage (from shims):
//   import { getMemo, setMemo, delMemo, clearMemo } from "@/agents/runtime/reasoner/cache/memo";
//
//   const cached = await getMemo(cacheKey);
//   await setMemo(cacheKey, { mode, data, warnings, debug, savedAt: isoNow() }, { ttlMs: 15 * 60_000 });
//
// Notes
// - Avoids hard dependency on a specific DB module name/path by attempting to
//   resolve known patterns. If no DB exists, silently uses memory cache.
// - Values are JSON-serializable objects.
// - TTL is enforced on read; expired entries are deleted.
//
// Table expectation (optional, recommended):
// - If you have a Dexie db, add a table such as `reasoner_cache` with:
//     key (primary), savedAt, expiresAt, domain, intent, mode, payload
//   but this module will also work with a simpler table shape:
//     key, value, savedAt, expiresAt
//
// If you don't have such a table yet, this module still works in memory.
// You can later wire it to your db by adding a compatible table.

const DEFAULT_TTL_MS = 10 * 60_000; // 10 minutes
const MAX_ITEM_BYTES_SOFT = 750_000; // soft safety limit (approx) to avoid huge payloads

// In-memory cache fallback
const memory = new Map();

/* -------------------------------------------------------------------------- */
/* small utils                                                                */
/* -------------------------------------------------------------------------- */

function isoNow() {
  return new Date().toISOString();
}

function toNumberOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function nowMs() {
  return Date.now();
}

function safeJsonSizeBytes(obj) {
  try {
    return new TextEncoder().encode(JSON.stringify(obj)).length;
  } catch {
    // if circular, etc.
    return null;
  }
}

function normalizeKey(key) {
  if (typeof key === "string") return key;
  try {
    return JSON.stringify(key);
  } catch {
    return String(key);
  }
}

function isExpired(expiresAt) {
  if (expiresAt == null) return false;
  const ms =
    typeof expiresAt === "number"
      ? expiresAt
      : typeof expiresAt === "string"
      ? Date.parse(expiresAt)
      : null;
  if (!ms || !Number.isFinite(ms)) return false;
  return ms <= nowMs();
}

function computeExpiresAt({ ttlMs, expiresAt }) {
  if (expiresAt) return expiresAt;
  const ttl = typeof ttlMs === "number" && ttlMs >= 0 ? ttlMs : DEFAULT_TTL_MS;
  return nowMs() + ttl;
}

function shallowClone(v) {
  if (!v || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.slice();
  return { ...v };
}

/* -------------------------------------------------------------------------- */
/* Dexie resolution (best-effort)                                             */
/* -------------------------------------------------------------------------- */

/**
 * Try to locate your Dexie instance/table without crashing builds if missing.
 * This is intentionally conservative: we only attempt known literal imports.
 *
 * If your project has a stable db module, you can simplify this later by
 * directly importing it here.
 */
async function resolveDexieTable() {
  // Cache resolution so we don't repeatedly import/scan
  if (resolveDexieTable._cached !== undefined) return resolveDexieTable._cached;
  resolveDexieTable._cached = null;

  // Known candidate modules (adjust later if you standardize)
  const candidates = [
    "@/services/db", // common
    "@/services/db/index",
    "@/db", // sometimes
    "@/db/index",
    "@/services/db.js",
  ];

  for (const spec of candidates) {
    try {
      // NOTE: path must be literal for Vite
      // eslint-disable-next-line no-await-in-loop
      const mod = await import(/* @vite-ignore */ spec);
      if (!mod) continue;

      // Common patterns:
      // - mod.db is Dexie instance
      // - mod.default is Dexie instance
      // - mod.sukaDb, mod.ssaDb, etc.
      const db =
        mod.db ||
        mod.default ||
        mod.sukaDb ||
        mod.ssaDb ||
        mod.database ||
        null;

      if (!db) continue;

      // Prefer explicit `reasoner_cache` table
      const table =
        db.reasoner_cache || db.reasonerCache || db.cache || db.memos || null;

      // If the db exists but the table doesn't, we can't use Dexie here.
      if (!table || typeof table.get !== "function") continue;

      resolveDexieTable._cached = table;
      return table;
    } catch {
      // ignore and continue
    }
  }

  return null;
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Get memoized value by key.
 *
 * @param {string|Object} key
 * @param {Object} [opts]
 * @param {boolean} [opts.allowStale=false] if true, returns even if expired
 * @returns {Promise<Object|null>}
 */
export async function getMemo(key, opts = {}) {
  const k = normalizeKey(key);
  const allowStale = !!opts.allowStale;

  // 1) Try Dexie
  const table = await resolveDexieTable();
  if (table) {
    try {
      const row = await table.get(k);
      if (!row) return null;

      // Accept multiple row shapes:
      // A) { key, value, savedAt, expiresAt }
      // B) { key, payload, savedAt, expiresAt, mode, domain, intent }
      // C) { id/key, data/value/payload, ... }
      const expiresAt = row.expiresAt ?? row.expiry ?? row.expires ?? null;
      const expired = !allowStale && isExpired(expiresAt);

      if (expired) {
        try {
          await table.delete(k);
        } catch {
          // ignore
        }
        return null;
      }

      const payload =
        row.value ?? row.payload ?? row.data ?? row.result ?? row.memo ?? null;

      // If payload is missing but row itself looks like the payload, return row
      const out = payload != null ? payload : row;

      // Shallow clone for safety
      return shallowClone(out);
    } catch {
      // fall through to memory cache
    }
  }

  // 2) Memory fallback
  const entry = memory.get(k);
  if (!entry) return null;
  if (!allowStale && isExpired(entry.expiresAt)) {
    memory.delete(k);
    return null;
  }
  return shallowClone(entry.value);
}

/**
 * Set memoized value.
 *
 * @param {string|Object} key
 * @param {Object} value - JSON-serializable recommended
 * @param {Object} [opts]
 * @param {number} [opts.ttlMs] - time to live in ms (default: 10 minutes)
 * @param {number|string} [opts.expiresAt] - overrides ttlMs
 * @param {string} [opts.domain]
 * @param {string} [opts.intent]
 * @param {string} [opts.mode]
 * @param {boolean} [opts.forceMemory=false] - skip Dexie write
 * @returns {Promise<{ok: boolean, storage: "dexie"|"memory", reason?: string}>}
 */
export async function setMemo(key, value, opts = {}) {
  const k = normalizeKey(key);
  const forceMemory = !!opts.forceMemory;

  // Soft size guard (don’t hard-fail; just switch to memory if huge)
  const sizeBytes = safeJsonSizeBytes(value);
  const tooLarge = sizeBytes != null && sizeBytes > MAX_ITEM_BYTES_SOFT;

  const expiresAt = computeExpiresAt({
    ttlMs: opts.ttlMs,
    expiresAt: opts.expiresAt,
  });

  const savedAt = opts.savedAt || isoNow();

  // 1) Try Dexie unless forced to memory or too large
  if (!forceMemory && !tooLarge) {
    const table = await resolveDexieTable();
    if (table) {
      try {
        // Write in a flexible shape that works with most designs
        const row = {
          key: k,
          savedAt,
          expiresAt,
          domain: opts.domain || null,
          intent: opts.intent || null,
          mode: opts.mode || null,
          payload: value,
        };

        await table.put(row);
        return { ok: true, storage: "dexie" };
      } catch (err) {
        // fall through to memory
        const reason = String(err);
        memory.set(k, { value, savedAt, expiresAt });
        return { ok: true, storage: "memory", reason };
      }
    }
  }

  // 2) Memory fallback
  memory.set(k, { value, savedAt, expiresAt });
  return {
    ok: true,
    storage: "memory",
    ...(tooLarge ? { reason: "payload-too-large-for-soft-limit" } : {}),
  };
}

/**
 * Delete one memo by key.
 *
 * @param {string|Object} key
 * @returns {Promise<boolean>}
 */
export async function delMemo(key) {
  const k = normalizeKey(key);

  let ok = false;

  const table = await resolveDexieTable();
  if (table) {
    try {
      await table.delete(k);
      ok = true;
    } catch {
      // ignore
    }
  }

  if (memory.has(k)) {
    memory.delete(k);
    ok = true;
  }

  return ok;
}

/**
 * Clear all memos.
 *
 * - Dexie: clears the table if available.
 * - Memory: clears the Map.
 *
 * @returns {Promise<{dexie: boolean, memory: boolean}>}
 */
export async function clearMemo() {
  let dexieOk = false;

  const table = await resolveDexieTable();
  if (table) {
    try {
      if (typeof table.clear === "function") {
        await table.clear();
        dexieOk = true;
      } else if (typeof table.toCollection === "function") {
        await table.toCollection().delete();
        dexieOk = true;
      }
    } catch {
      // ignore
    }
  }

  memory.clear();
  return { dexie: dexieOk, memory: true };
}

/**
 * Garbage collect expired items.
 * - Dexie: scans and deletes expired rows if schema provides expiresAt.
 * - Memory: deletes expired entries.
 *
 * @param {Object} [opts]
 * @param {number} [opts.limit=500] limit deletions per run for Dexie
 * @returns {Promise<{deleted: number, storage: "dexie+memory"|"memory"|"dexie"}>}
 */
export async function gcMemo(opts = {}) {
  const limit = toNumberOrNull(opts.limit) ?? 500;
  let deleted = 0;
  let didDexie = false;

  // Memory GC
  for (const [k, entry] of memory.entries()) {
    if (isExpired(entry.expiresAt)) {
      memory.delete(k);
      deleted += 1;
    }
  }

  // Dexie GC (best-effort)
  const table = await resolveDexieTable();
  if (table) {
    try {
      didDexie = true;

      // If table supports where("expiresAt").belowOrEqual(...) we can do indexed delete.
      // If not indexed, we fall back to iterating a bounded collection.
      if (typeof table.where === "function") {
        // Try indexed query
        try {
          const now = nowMs();
          const coll = table.where("expiresAt").belowOrEqual(now);
          const keys = await coll.primaryKeys();
          const slice = keys.slice(0, limit);
          // eslint-disable-next-line no-await-in-loop
          for (const k of slice) {
            // eslint-disable-next-line no-await-in-loop
            await table.delete(k);
            deleted += 1;
          }
          return {
            deleted,
            storage: "dexie+memory",
          };
        } catch {
          // continue to safe scan fallback
        }
      }

      // Safe scan fallback (bounded)
      if (typeof table.toCollection === "function") {
        const rows = await table.toCollection().limit(limit).toArray();
        for (const row of rows) {
          const expiresAt = row.expiresAt ?? row.expiry ?? row.expires ?? null;
          if (isExpired(expiresAt)) {
            // eslint-disable-next-line no-await-in-loop
            await table.delete(row.key ?? row.id);
            deleted += 1;
          }
        }
      }
    } catch {
      // ignore
    }
  }

  return {
    deleted,
    storage: didDexie ? "dexie+memory" : "memory",
  };
}

/* -------------------------------------------------------------------------- */
/* Back-compat exports expected by shims                                      */
/* -------------------------------------------------------------------------- */

/**
 * procurementShim expects:
 *   import { getCachedResult, setCachedResult } from "./cache/memo"
 *
 * Provide thin aliases to the existing memo API.
 * - getCachedResult -> getMemo
 * - setCachedResult -> setMemo
 */
export async function getCachedResult(key, opts = {}) {
  return getMemo(key, opts);
}

export async function setCachedResult(key, value, opts = {}) {
  return setMemo(key, value, opts);
}

/**
 * Some callers (sababShim.js) expect:
 *   import { getMemoized, setMemoized } from "./cache/memo"
 *
 * Provide aliases.
 */
export async function getMemoized(key, opts = {}) {
  return getMemo(key, opts);
}

export async function setMemoized(key, value, opts = {}) {
  return setMemo(key, value, opts);
}

/**
 * Some callers may also expect these names.
 */
export async function deleteCachedResult(key) {
  return delMemo(key);
}

export async function clearCachedResults() {
  return clearMemo();
}

export default {
  getMemo,
  setMemo,
  delMemo,
  clearMemo,
  gcMemo,
  getCachedResult,
  setCachedResult,
  getMemoized,
  setMemoized,
  deleteCachedResult,
  clearCachedResults,
};
