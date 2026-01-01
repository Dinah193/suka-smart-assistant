/**
 * @file C:\Users\larho\suka-smart-assistant\src\services\nutrition\NutritionResolver.js
 *
 * NutritionResolver — smart, offline-first resolver for nutrition metadata.
 *
 * PIPELINE FIT (imports → intelligence → automation → (optional) hub export):
 * - Imports/scrapers produce raw food names. Call `resolve(foodName)` here:
 *   1) Normalize name (synonyms, lowercase, diacritics).
 *   2) Check local Dexie cache via NutritionStore (offline-first).
 *   3) If missing or stale → query central API through DataGateway (online).
 *   4) If still unavailable → return a typed "SCRAPE_REQUIRED" error so UI/agents
 *      can optionally schedule a scraper task later (do NOT auto-scrape here).
 * - This module *does not* mutate household inventory/storehouse; therefore it does
 *   NOT export to the Hub. It emits automation events for observability.
 *
 * EVENT ENVELOPE (consistent shape): { type, ts, source, data }
 *   - nutrition.lookup.started
 *   - nutrition.lookup.cache.hit
 *   - nutrition.lookup.cache.miss
 *   - nutrition.lookup.api.fetched
 *   - nutrition.lookup.api.notfound
 *   - nutrition.lookup.error
 */

import eventBus from 'src/services/eventBus.js';
import NutritionStore from 'src/data/nutrition/NutritionStore.js';

/** Module identity for events */
const SOURCE = 'NutritionResolver';

/** Default staleness window for cached entries */
const DEFAULT_MAX_AGE_DAYS = 180;

/**
 * Resolve nutrition data for a food name.
 *
 * @param {string} foodName - raw name from imports (e.g., "Garbanzo Beans")
 * @param {Object} [options]
 * @param {number} [options.maxAgeDays=180] - TTL for cache freshness
 * @param {boolean} [options.allowStale=true] - if true, return stale cache when API fails
 * @param {boolean} [options.preferFresh=false] - if true, always check API even on cache hit
 * @returns {Promise<{
 *   ok: boolean,
 *   source: 'cache'|'api'|'missing',
 *   id?: string,
 *   normalizedName?: string,
 *   nutrition?: Record<string, any>,
 *   cache?: { lastUpdated?: string },
 *   error?: string,
 *   reason?: 'MISSING'|'STALE'|'SCRAPE_REQUIRED'|'GATEWAY_UNAVAILABLE'|'INVALID_INPUT'
 * }>}
 */
export async function resolve(foodName, options = {}) {
  const opts = {
    maxAgeDays: toPositiveInt(options.maxAgeDays, DEFAULT_MAX_AGE_DAYS),
    allowStale: options.allowStale !== false, // default true
    preferFresh: options.preferFresh === true,
  };

  if (!isNonEmptyString(foodName)) {
    emit('nutrition.lookup.error', { reason: 'INVALID_INPUT' });
    return { ok: false, source: 'missing', error: 'Invalid foodName', reason: 'INVALID_INPUT' };
  }

  emit('nutrition.lookup.started', { foodName });

  // 1) Try cache (NutritionStore does normalization internally in its getters)
  let cached = null;
  try {
    cached = await NutritionStore.getByNormalizedName(foodName);
  } catch (err) {
    // cache errors should not break flow — continue to API
    emit('nutrition.lookup.error', { step: 'cache', message: err?.message || 'cache error' });
  }

  const normalizedName = cached?.normalizedName || await bestEffortNormalize(foodName);

  // Check staleness
  const stale = isStale(cached?.lastUpdated, opts.maxAgeDays);

  // If we have a fresh cache and we're not forcing freshness → return it.
  if (cached && !stale && !opts.preferFresh) {
    emit('nutrition.lookup.cache.hit', {
      id: cached.id,
      normalizedName,
      lastUpdated: cached.lastUpdated,
      stale: false,
    });
    // NOTE: NutritionStore currently stores just identity fields; nutrition payload
    // may be retrieved from central DB when you add macro/micro tables.
    return {
      ok: true,
      source: 'cache',
      id: cached.id,
      normalizedName,
      nutrition: undefined,
      cache: { lastUpdated: cached.lastUpdated },
    };
  }

  // 2) Cache miss or stale → try central API
  if (!cached) {
    emit('nutrition.lookup.cache.miss', { normalizedName });
  } else {
    emit('nutrition.lookup.cache.hit', {
      id: cached.id,
      normalizedName,
      lastUpdated: cached.lastUpdated,
      stale: true,
    });
  }

  const api = await getGateway();
  if (!api) {
    // Gateway unavailable — return stale cache if allowed; otherwise signal scrape
    if (cached && opts.allowStale) {
      return {
        ok: true,
        source: 'cache',
        id: cached.id,
        normalizedName,
        nutrition: undefined,
        cache: { lastUpdated: cached.lastUpdated },
      };
    }
    emit('nutrition.lookup.error', { reason: 'GATEWAY_UNAVAILABLE', normalizedName });
    return {
      ok: false,
      source: 'missing',
      error: 'Central API unavailable',
      reason: 'GATEWAY_UNAVAILABLE',
    };
  }

  // Attempt different gateway methods defensively
  let apiResult = null;
  try {
    apiResult =
      (typeof api.nutritionLookup === 'function' && (await api.nutritionLookup(normalizedName))) ||
      (api.nutrition && typeof api.nutrition.lookup === 'function' && (await api.nutrition.lookup(normalizedName))) ||
      (typeof api.getNutrition === 'function' && (await api.getNutrition(normalizedName))) ||
      null;
  } catch (err) {
    emit('nutrition.lookup.error', { step: 'api', message: err?.message || 'api error', normalizedName });
  }

  if (apiResult && apiResult.ok && apiResult.data) {
    // 3) Persist minimal identity to local cache for offline use.
    //    (If you later add nutrition tables, upsert them here too.)
    const id = apiResult.data.id || cached?.id || generateDeterministicId(normalizedName);
    await NutritionStore.upsert({
      id,
      foodName,
      normalizedName,
      lastUpdated: nowISO(),
    });

    emit('nutrition.lookup.api.fetched', { id, normalizedName });

    return {
      ok: true,
      source: 'api',
      id,
      normalizedName,
      nutrition: apiResult.data, // pass through full payload to caller
      cache: { lastUpdated: nowISO() },
    };
  }

  // 4) Still not found → advise optional scrape later
  emit('nutrition.lookup.api.notfound', { normalizedName });

  if (cached && opts.allowStale) {
    // Return stale cache if permitted — caller may schedule scrape separately.
    return {
      ok: true,
      source: 'cache',
      id: cached.id,
      normalizedName,
      nutrition: undefined,
      cache: { lastUpdated: cached.lastUpdated },
    };
  }

  return {
    ok: false,
    source: 'missing',
    error: 'Nutrition not found in cache or API',
    normalizedName,
    reason: 'SCRAPE_REQUIRED',
  };
}

// ───────────────────────────────────────────────────────────────────────────────
// Utilities & helpers (single-file, single-use)

function emit(type, data) {
  try {
    eventBus.emit('automation.event', {
      type,
      ts: nowISO(),
      source: SOURCE,
      data,
    });
  } catch {
    // never throw from event emissions
  }
}

function nowISO() {
  return new Date().toISOString();
}

function toPositiveInt(n, fallback) {
  const x = Number.parseInt(n, 10);
  return Number.isFinite(x) && x > 0 ? x : fallback;
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

function daysBetween(iso) {
  if (!iso) return Infinity;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return Infinity;
  const diffMs = Date.now() - then;
  return diffMs / (1000 * 60 * 60 * 24);
}

function isStale(lastUpdatedISO, maxAgeDays) {
  return daysBetween(lastUpdatedISO) > maxAgeDays;
}

/**
 * Attempt to normalize via NutritionStore fast-path:
 * - `getByNormalizedName(name)` internally normalizes input,
 *    so we can "peek" at what the canonical would be by writing and reading.
 * - If store has nothing yet, compute a local canonical form here (mirrors store heuristics).
 */
async function bestEffortNormalize(name) {
  try {
    const hit = await NutritionStore.getByNormalizedName(name);
    if (hit?.normalizedName) return hit.normalizedName;
  } catch {
    // ignore
  }
  return localNormalize(name);
}

/** Minimal local normalization (kept in sync with NutritionStore heuristics) */
function localNormalize(name) {
  if (!isNonEmptyString(name)) return '';
  const base = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^a-z0-9\s\-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // very light plural → singular heuristic
  const singular = base.endsWith('s') && !base.endsWith('ss') ? base.slice(0, -1) : base;
  return singular;
}

/**
 * Soft-import the central DataGateway with multiple fallback shapes:
 * - default export with methods
 * - named `nutrition` namespace with `lookup()`
 * - named `nutritionLookup()` function
 */
async function getGateway() {
  try {
    const mod = await import(/* @vite-ignore */ 'src/services/dataGateway.js');
    // Normalize shape for callers
    const api = mod?.default || mod;
    return api || null;
  } catch {
    return null;
  }
}

/** Deterministic id (mirrors NutritionStore’s generator) */
function generateDeterministicId(normalizedName) {
  const norm = localNormalize(normalizedName);
  if (!norm) return null;
  return `food:${norm}:${djb2(norm)}`;
}

function djb2(str) {
  let hash = 5381;
  for (let i = 0; i < str.length; i += 1) {
    hash = ((hash << 5) + hash) ^ str.charCodeAt(i);
  }
  return (hash >>> 0).toString(16);
}

// ───────────────────────────────────────────────────────────────────────────────
// Forward-looking extension points:
// - Add optional `scrapeStrategy` param to `resolve()` that, when explicitly allowed by
//   the caller, kicks off an async scraper job (separate worker/module) and emits
//   `nutrition.scrape.requested` with correlation id.
// - When macros/micros tables land in NutritionStore, persist API results into those
//   tables here (inside the same resolve call) to keep a single-write path.
// - Add rate-limit/backoff cache for gateway 404s to avoid repeated misses.

export default { resolve }
