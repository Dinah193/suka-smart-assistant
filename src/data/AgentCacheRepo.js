// C:\Users\larho\suka-smart-assistant\src\data\AgentCacheRepo.js
// -----------------------------------------------------------------------------
// Suka Smart Assistant (SSA) – Agent Cache Repository
// -----------------------------------------------------------------------------
// How this fits:
//   - Wraps Dexie (db.agentCache) + in-memory fallback to cache Reasoner
//     requests/responses for all domains:
//
//       • cooking (meal planning, batch cooking)
//       • cleaning (daily resets, deep cleans)
//       • garden (planning, care, harvest)
//       • animals (acquisition, care, butchery)
//       • preservation (canning, dehydrating, etc.)
//       • storehouse (stock planning via grocery sections)
//
//   - Supports both forward and reverse generation modes.
//   - Lets the orchestrator quickly reuse recent plans instead of re-invoking
//     LLM/reasoners when inputs are effectively identical.
//   - Caches domain hints (storehouse grocery sections, garden seasons/beds,
//     animal species/stages) so reverse-generation and analytics can mine them.
//
// Responsibilities:
//   • Generate / manage cache keys for reasoning requests.
//   • Store ReasonerRequest + ReasonerResponse + ReasonerError.
//   • TTL / expiry handling per domain & mode.
//   • Small query helpers for "similar cached plans" by domain/user/mode.
//   • Dexie table wrapper with safe in-memory fallback.
//
// This file is DATA-ONLY. It does NOT:
//   - show UI
//   - emit events
//   - talk to the Hub
//
// Orchestrator usage sketch:
//
//   import AgentCacheRepo = require("@/data/AgentCacheRepo");
//   import { callReasoner } from "@/agents/orchestrator"; // your shim
//
//   async function getOrPlan(request) {
//     const cached = await AgentCacheRepo.getCachedPlanForRequest(request);
//     if (cached) return cached.response;
//
//     const fresh = await callReasoner(request);
//     await AgentCacheRepo.saveCacheForRequest(request, fresh.response, fresh.error);
//     return fresh.response;
//   }
// -----------------------------------------------------------------------------

"use strict";

/**
 * @typedef {import("@/types/agent.contracts").AgentDomain} AgentDomain
 * @typedef {import("@/types/agent.contracts").AgentSubdomain} AgentSubdomain
 * @typedef {import("@/types/agent.contracts").ReasonerInvocationMode} ReasonerInvocationMode
 * @typedef {import("@/types/agent.contracts").ReasonerRequest} ReasonerRequest
 * @typedef {import("@/types/agent.contracts").ReasonerResponse} ReasonerResponse
 * @typedef {import("@/types/agent.contracts").ReasonerError} ReasonerError
 */

let db = null;
try {
  // eslint-disable-next-line global-require, import/no-unresolved
  const dbModule = require("@/services/db");
  db = dbModule.db || dbModule.default || dbModule;
} catch (err) {
  // Dexie not available – we'll fall back to memory.
  // console.warn("[AgentCacheRepo] Dexie db not available, using in-memory cache only.", err);
}

/**
 * In-memory cache fallback.
 * Map<cacheKey, AgentCacheEntry>
 * @type {Map<string, AgentCacheEntry>}
 */
const memoryCache = new Map();

/**
 * @typedef AgentCacheEntry
 * @property {string} id             // primary key in Dexie; equals cacheKey
 * @property {string} key            // cache key
 * @property {AgentDomain} domain
 * @property {AgentSubdomain} [subdomain]
 * @property {ReasonerInvocationMode} mode    // "forward" | "reverse" | "repair"
 * @property {string} userId
 * @property {string} createdAt      // ISO
 * @property {string} updatedAt      // ISO
 * @property {string|null} expiresAt // ISO | null
 * @property {ReasonerRequest} request
 * @property {ReasonerResponse|null} response
 * @property {ReasonerError|null} error
 * @property {number} usageCount
 * @property {string|null} lastUsedAt // ISO | null
 * @property {string[]} tags
 * @property {AgentCacheMeta} meta
 */

/**
 * Meta fields are designed to capture domain-intuitive hints for reverse
 * generation and analytics while staying flexible.
 *
 * @typedef AgentCacheMeta
 * @property {string[]} [storehouseSections]  // e.g. ["produce","meat+freezer"]
 * @property {string[]} [gardenBeds]          // bed IDs or labels
 * @property {string[]} [gardenCrops]         // crop IDs or names
 * @property {string[]} [animalSpecies]       // e.g. ["goats","sheep"]
 * @property {"acquisition"|"care"|"butchery"} [animalStage]
 * @property {"planning"|"care"|"harvest"} [gardenMode]
 * @property {"mealPlanning"|"batchCooking"|"reset"} [mealMode]
 * @property {boolean} [sabbathGuardApplied]
 * @property {boolean} [usedInventoryShortages]
 * @property {AgentDomain[]} [crossDomainConsulted]
 * @property {Record<string, any>} [extra] // open-ended for future hints
 */

/**
 * TTL defaults (milliseconds) by domain + mode.
 * You can tweak these later as needed.
 *
 * - Cooking / batch planning: shorter TTL (6h) because ingredients change.
 * - Cleaning templates: longer TTL (24h) since tasks are stable.
 * - Garden planning: up to 3 days (259200000ms) per season planning.
 * - Animals & preservation: 1 day by default.
 * - Storehouse stock-up: 12h so shortages update reasonably often.
 */
const DEFAULT_TTL_MS = {
  cooking: {
    forward: 6 * 60 * 60 * 1000,
    reverse: 24 * 60 * 60 * 1000,
    repair: 2 * 60 * 60 * 1000
  },
  cleaning: {
    forward: 24 * 60 * 60 * 1000,
    reverse: 24 * 60 * 60 * 1000,
    repair: 4 * 60 * 60 * 1000
  },
  garden: {
    forward: 3 * 24 * 60 * 60 * 1000,
    reverse: 3 * 24 * 60 * 60 * 1000,
    repair: 6 * 60 * 60 * 1000
  },
  animals: {
    forward: 24 * 60 * 60 * 1000,
    reverse: 24 * 60 * 60 * 1000,
    repair: 4 * 60 * 60 * 1000
  },
  preservation: {
    forward: 24 * 60 * 60 * 1000,
    reverse: 24 * 60 * 60 * 1000,
    repair: 4 * 60 * 60 * 1000
  },
  storehouse: {
    forward: 12 * 60 * 60 * 1000,
    reverse: 24 * 60 * 60 * 1000,
    repair: 4 * 60 * 60 * 1000
  }
};

/**
 * Optional overrides at runtime.
 * @type {Record<string, number>}
 */
const ttlOverridesMs = {};

/**
 * Generate a cache key from a ReasonerRequest.
 * This is intentionally simple and stable *enough* for household usage.
 * If you need stronger stability, you can later plug in a real hash function.
 *
 * @param {ReasonerRequest} request
 * @returns {string}
 */
function computeCacheKeyFromRequest(request) {
  const safeUserId = request.user?.id || "anon";
  const safeDomain = request.domain || "cooking";
  const safeMode = request.mode || "forward";

  // Shallow, predictable JSON+string key – we avoid including highly volatile
  // fields like timestamps inside request.links, if possible.
  const payload = {
    domain: safeDomain,
    subdomain: request.subdomain || null,
    mode: safeMode,
    userId: safeUserId,
    goals: request.goals || [],
    constraints: request.constraints || {},
    links: request.links || {},
    reverseSources: request.reverseGenerationSources || []
  };

  // Poor-man's hash: length + base36 timestamp + substring of JSON.
  const base = JSON.stringify(payload);
  const preview = base.length > 256 ? base.slice(0, 256) : base;
  const stamp = Date.now().toString(36);
  const keyCore = `${safeUserId}:${safeDomain}:${safeMode}:${preview}`;
  let hash = 0;
  for (let i = 0; i < keyCore.length; i += 1) {
    hash = (hash << 5) - hash + keyCore.charCodeAt(i);
    hash |= 0; // 32bit int
  }

  return `agentCache_${safeUserId}_${safeDomain}_${safeMode}_${Math.abs(hash)}_${stamp}`;
}

/**
 * Get TTL (in ms) for a given domain + mode.
 *
 * @param {AgentDomain} domain
 * @param {ReasonerInvocationMode} mode
 * @returns {number}
 */
function getTtlFor(domain, mode) {
  const key = `${domain}.${mode}`;
  if (Object.prototype.hasOwnProperty.call(ttlOverridesMs, key)) {
    return ttlOverridesMs[key];
  }

  const perDomain = DEFAULT_TTL_MS[domain] || DEFAULT_TTL_MS.cooking;
  const perMode = perDomain[mode] || perDomain.forward || 6 * 60 * 60 * 1000;
  return perMode;
}

/**
 * Set or clear a TTL override at runtime.
 * @param {AgentDomain} domain
 * @param {ReasonerInvocationMode} mode
 * @param {number|null} ttlMs
 */
function setTtlOverride(domain, mode, ttlMs) {
  const key = `${domain}.${mode}`;
  if (ttlMs == null) {
    delete ttlOverridesMs[key];
  } else {
    ttlOverridesMs[key] = ttlMs;
  }
}

/**
 * @returns {import("dexie").Table<AgentCacheEntry, string>|null}
 */
function getAgentCacheTable() {
  if (!db || !db.agentCache) return null;
  return db.agentCache;
}

/**
 * Extract domain-aware hints from request into meta.
 * This is where we hook in your domain structure:
 *  - garden: planning/care/harvest, beds, crops
 *  - animals: species, acquisition/care/butchery
 *  - storehouse: grocery sections
 *  - meals: mealPlanning/batchCooking, storehouse sections
 *
 * @param {ReasonerRequest} request
 * @returns {AgentCacheMeta}
 */
function buildMetaFromRequest(request) {
  /** @type {AgentCacheMeta} */
  const meta = { extra: {} };
  const domain = request.domain;

  if (domain === "garden") {
    const hints = request.constraints || {};
    meta.gardenMode =
      /** @type {any} */ (hints.gardenMode) || "planning";
    meta.gardenBeds = /** @type {string[]} */ (
      (hints.gardenBeds || hints.bedIds || [])
    );
    meta.gardenCrops = /** @type {string[]} */ (
      (hints.gardenCrops || hints.crops || [])
    );
  }

  if (domain === "animals") {
    const hints = request.constraints || {};
    meta.animalSpecies = /** @type {string[]} */ (
      (hints.animalSpecies || hints.species || [])
    );
    meta.animalStage =
      /** @type {any} */ (hints.animalStage) ||
      (hints.includeButchery ? "butchery" : "care");
  }

  if (domain === "storehouse" || domain === "cooking" || domain === "preservation") {
    const hints = request.constraints || {};
    meta.storehouseSections = /** @type {string[]} */ (
      hints.prioritizeSections || hints.storehouseSections || []
    );
  }

  if (domain === "cooking") {
    const hints = request.constraints || {};
    meta.mealMode =
      /** @type {any} */ (hints.mealMode) ||
      (hints.mealsPerDay && hints.mealsPerDay > 1 ? "mealPlanning" : "batchCooking");
  }

  // Guard hints
  const guard = request.constraints || {};
  if (typeof guard.sabbathSafe === "boolean") {
    meta.sabbathGuardApplied = guard.sabbathSafe;
  }

  // Keep a copy of all constraints & links inside extra for debugging/future mining.
  meta.extra = {
    ...meta.extra,
    constraints: request.constraints || {},
    links: request.links || {}
  };

  return meta;
}

/**
 * Normalize tags for a cache entry, based on domain and meta.
 * @param {AgentDomain} domain
 * @param {ReasonerInvocationMode} mode
 * @param {AgentCacheMeta} meta
 * @returns {string[]}
 */
function buildTags(domain, mode, meta) {
  const tags = [`domain:${domain}`, `mode:${mode}`];

  if (meta.gardenMode) tags.push(`gardenMode:${meta.gardenMode}`);
  if (meta.animalStage) tags.push(`animalStage:${meta.animalStage}`);
  if (meta.mealMode) tags.push(`mealMode:${meta.mealMode}`);
  if (meta.storehouseSections && meta.storehouseSections.length > 0) {
    for (const section of meta.storehouseSections) {
      tags.push(`storehouseSection:${section}`);
    }
  }
  if (meta.animalSpecies && meta.animalSpecies.length > 0) {
    for (const sp of meta.animalSpecies) {
      tags.push(`animal:${sp}`);
    }
  }
  if (meta.gardenCrops && meta.gardenCrops.length > 0) {
    for (const c of meta.gardenCrops) {
      tags.push(`crop:${c}`);
    }
  }

  return tags;
}

/**
 * Build a new cache entry from a ReasonerRequest + ReasonerResponse/Error.
 *
 * @param {string} key
 * @param {ReasonerRequest} request
 * @param {ReasonerResponse|null} response
 * @param {ReasonerError|null} error
 * @returns {AgentCacheEntry}
 */
function buildEntry(key, request, response, error) {
  const nowIso = new Date().toISOString();
  const ttlMs = getTtlFor(request.domain, request.mode);
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();

  const meta = buildMetaFromRequest(request);
  const tags = buildTags(request.domain, request.mode, meta);

  return {
    id: key,
    key,
    domain: request.domain,
    subdomain: request.subdomain,
    mode: request.mode,
    userId: request.user?.id || "anon",
    createdAt: nowIso,
    updatedAt: nowIso,
    expiresAt,
    request,
    response,
    error,
    usageCount: 0,
    lastUsedAt: null,
    tags,
    meta
  };
}

/**
 * Persist a cache entry to Dexie + memory.
 * @param {AgentCacheEntry} entry
 * @returns {Promise<AgentCacheEntry>}
 */
async function saveEntry(entry) {
  const table = getAgentCacheTable();
  if (table) {
    try {
      await table.put(entry);
    } catch (err) {
      // console.error("[AgentCacheRepo] Failed to write to Dexie, using memory only.", err);
    }
  }
  memoryCache.set(entry.key, entry);
  return entry;
}

/**
 * Get a cache entry by *cache key*.
 *
 * @param {string} key
 * @returns {Promise<AgentCacheEntry|null>}
 */
async function getEntryByKey(key) {
  if (!key) return null;

  const table = getAgentCacheTable();
  if (table) {
    try {
      const entry = await table.get(key);
      if (entry) {
        memoryCache.set(key, entry);
        return entry;
      }
    } catch (err) {
      // fall through to memory
    }
  }

  const mem = memoryCache.get(key);
  return mem || null;
}

/**
 * Mark an entry as used: increment usageCount & update lastUsedAt.
 * @param {AgentCacheEntry} entry
 * @returns {Promise<AgentCacheEntry>}
 */
async function touchEntryUsage(entry) {
  const nowIso = new Date().toISOString();
  const updated = {
    ...entry,
    usageCount: (entry.usageCount || 0) + 1,
    lastUsedAt: nowIso,
    updatedAt: nowIso
  };
  return saveEntry(updated);
}

/**
 * Check if entry is expired (based on expiresAt).
 * @param {AgentCacheEntry} entry
 * @param {string} nowIso
 * @returns {boolean}
 */
function isExpired(entry, nowIso) {
  if (!entry.expiresAt) return false;
  return entry.expiresAt <= nowIso;
}

/**
 * Public helper: get a cached plan for a given ReasonerRequest.
 *
 * - Generates a cache key (or uses the provided override).
 * - Looks up entry.
 * - Checks TTL + domain/mode/user match.
 * - Returns {entry, key} or null when not found/expired.
 *
 * @param {ReasonerRequest} request
 * @param {{ cacheKeyOverride?: string }} [opts]
 * @returns {Promise<{ key: string, entry: AgentCacheEntry } | null>}
 */
async function getCachedPlanForRequest(request, opts = {}) {
  if (!request || !request.user || !request.user.id) return null;
  if (!request.domain || !request.mode) return null;

  const key = opts.cacheKeyOverride || computeCacheKeyFromRequest(request);
  const entry = await getEntryByKey(key);
  if (!entry) return null;

  const nowIso = new Date().toISOString();
  if (isExpired(entry, nowIso)) {
    // Optionally purge expired entry.
    await deleteEntryByKey(key);
    return null;
  }

  // Defensive: ensure domain/mode/user match (in case of key collisions).
  const sameDomain = entry.domain === request.domain;
  const sameMode = entry.mode === request.mode;
  const sameUser = entry.userId === (request.user?.id || "anon");

  if (!sameDomain || !sameMode || !sameUser) {
    return null;
  }

  const touched = await touchEntryUsage(entry);
  return { key, entry: touched };
}

/**
 * Public helper: save a ReasonerResponse/Error for a given ReasonerRequest.
 *
 * @param {ReasonerRequest} request
 * @param {ReasonerResponse|null} response
 * @param {ReasonerError|null} [error]
 * @param {{ cacheKeyOverride?: string }} [opts]
 * @returns {Promise<{ key: string, entry: AgentCacheEntry }>}
 */
async function saveCacheForRequest(request, response, error = null, opts = {}) {
  if (!request || !request.user || !request.user.id) {
    throw new Error("[AgentCacheRepo] request.user.id is required to cache");
  }

  const key = opts.cacheKeyOverride || computeCacheKeyFromRequest(request);

  const existing = await getEntryByKey(key);
  if (existing) {
    const nowIso = new Date().toISOString();
    const ttlMs = getTtlFor(existing.domain, existing.mode);
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();

    const updated = {
      ...existing,
      response,
      error,
      updatedAt: nowIso,
      expiresAt,
      // keep existing meta/tags; you can rebuild if needed
    };

    const saved = await saveEntry(updated);
    return { key, entry: saved };
  }

  const freshEntry = buildEntry(key, request, response, error);
  const savedFresh = await saveEntry(freshEntry);
  return { key, entry: savedFresh };
}

/**
 * Delete a cache entry by key.
 * @param {string} key
 * @returns {Promise<void>}
 */
async function deleteEntryByKey(key) {
  if (!key) return;
  const table = getAgentCacheTable();
  if (table) {
    try {
      await table.delete(key);
    } catch (err) {
      // ignore Dexie errors
    }
  }
  memoryCache.delete(key);
}

/**
 * Purge all expired entries (based on expiresAt <= now).
 * @returns {Promise<number>} number of entries removed
 */
async function purgeExpired() {
  const table = getAgentCacheTable();
  const nowIso = new Date().toISOString();
  let removed = 0;

  if (table) {
    try {
      const all = await table.toArray();
      const expiredIds = all.filter((e) => isExpired(e, nowIso)).map((e) => e.key);
      for (const id of expiredIds) {
        await table.delete(id);
        memoryCache.delete(id);
        removed += 1;
      }
      return removed;
    } catch (err) {
      // fall through to memory-only
    }
  }

  for (const [key, entry] of memoryCache.entries()) {
    if (isExpired(entry, nowIso)) {
      memoryCache.delete(key);
      removed += 1;
    }
  }
  return removed;
}

/**
 * List recent cached plans for a given domain/user/mode.
 *
 * Useful for reverse generation UIs like:
 *  - "Show me my recent cooking plans"
 *  - "Review reverse-generated templates for garden harvest"
 *
 * @param {AgentDomain} domain
 * @param {string} userId
 * @param {ReasonerInvocationMode[]} [modes]  // if omitted, all modes
 * @param {number} [limit]                    // default 20
 * @returns {Promise<AgentCacheEntry[]>}
 */
async function listRecentByDomain(domain, userId, modes, limit = 20) {
  const table = getAgentCacheTable();
  const allowedModes = Array.isArray(modes) && modes.length > 0 ? modes : null;
  /** @type {AgentCacheEntry[]} */
  let all = [];

  if (table) {
    try {
      const rows = await table.toArray();
      all = rows.filter((e) => {
        if (e.domain !== domain) return false;
        if (e.userId !== userId) return false;
        if (allowedModes && !allowedModes.includes(e.mode)) return false;
        return true;
      });
    } catch (err) {
      // fall back to memory-only
    }
  }

  if (!table) {
    for (const entry of memoryCache.values()) {
      if (entry.domain !== domain) continue;
      if (entry.userId !== userId) continue;
      if (allowedModes && !allowedModes.includes(entry.mode)) continue;
      all.push(entry);
    }
  }

  all.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
  return all.slice(0, limit);
}

/**
 * Special helper: list reverse-generation seeds for a domain & user.
 *
 * E.g., for MEALS, return cached reverse plans that turned repeated
 * Sunday batch cooking into templates.
 *
 * @param {AgentDomain} domain
 * @param {string} userId
 * @param {number} [limit]
 * @returns {Promise<AgentCacheEntry[]>}
 */
async function listReverseSeeds(domain, userId, limit = 20) {
  return listRecentByDomain(domain, userId, ["reverse"], limit);
}

/**
 * Clear ALL cache entries (use with care!).
 * @returns {Promise<void>}
 */
async function clearAll() {
  const table = getAgentCacheTable();
  if (table) {
    try {
      await table.clear();
    } catch (err) {
      // ignore Dexie errors
    }
  }
  memoryCache.clear();
}

module.exports = {
  // TTL management
  setTtlOverride,
  getTtlFor,

  // Core cache operations
  getCachedPlanForRequest,
  saveCacheForRequest,
  deleteEntryByKey,
  purgeExpired,

  // Query helpers
  listRecentByDomain,
  listReverseSeeds,

  // Maintenance
  clearAll
};
