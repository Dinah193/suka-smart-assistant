/**
 * @file C:\Users\larho\suka-smart-assistant\src\data\nutrition\NutritionStore.js
 *
 * NutritionStore — offline-first reference store for nutrition lookups.
 *
 * WHAT THIS DOES (imports → intelligence → automation → (optional) hub export):
 * - This module persists normalized nutrition metadata *locally* using Dexie/IndexedDB,
 *   so SSA can work offline and avoid re-scraping the same data.
 * - Typical pipeline:
 *   (1) imports/scrapers push raw food names → (2) we normalize names here
 *   → (3) store or refresh entries → (4) emit events so intelligence/automation
 *   can update suggestions, caches, and UIs.
 * - This store holds *reference data* (not household inventory). We emit events,
 *   but we do NOT export to the Hub (no household mutation). If, later, you decide
 *   to mirror lookups to the Hub, wire exportToHubIfEnabled in upsert() where noted.
 *
 * Dexie schema (DB = "SSA-Nutrition", table = "nutrition"):
 *   Primary key: id (string; caller-provided, e.g., canonical slug or upstream id)
 *   Indexes: normalizedName, foodName, lastUpdated
 *
 * Payload envelope for events (consistent shape):
 *   { type, ts, source, data }
 */

import Dexie from 'dexie';
import eventBus from 'src/services/eventBus.js';

// ───────────────────────────────────────────────────────────────────────────────
// Configuration & singletons

const DB_NAME = 'SSA-Nutrition';
const DB_VERSION = 1; // bump with schema changes
const TABLE = 'nutrition';
const SOURCE = 'NutritionStore';

/**
 * Dexie database singleton.
 * Versioned to allow future migrations (e.g., adding macro/micro tables).
 */
const db = new Dexie(DB_NAME);
db.version(DB_VERSION).stores({
  // id = primary key (string)
  // @index normalizedName for fast lookups
  // @index foodName for fuzzy matching and display searches
  // @index lastUpdated to prune stale entries
  [TABLE]: 'id, normalizedName, foodName, lastUpdated',
});

// ───────────────────────────────────────────────────────────────────────────────
// Name normalization — extensible registry

/**
 * Base synonym map. Keep minimal here; scrapers/parsers can extend at runtime via
 * registerSynonyms() without changing this file. Keys and values should be lowercase.
 */
const BUILTIN_SYNONYMS = {
  'garbanzo bean': 'chickpea',
  'garbanzo beans': 'chickpeas',
  'chick peas': 'chickpeas',
  'bell pepper': 'sweet pepper',
  'scallion': 'green onion',
  'scallions': 'green onions',
  'confectioners sugar': 'powdered sugar',
  'confectioner sugar': 'powdered sugar',
  'capsicum': 'sweet pepper',
};

let synonymMap = new Map(Object.entries(BUILTIN_SYNONYMS));

/**
 * Normalize a food display name → canonical token used as index key.
 * - lowercases
 * - trims
 * - collapses whitespace
 * - applies synonym map (one hop)
 */
function normalizeName(name) {
  if (!name || typeof name !== 'string') return '';
  const base = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^a-z0-9\s\-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const mapped = synonymMap.get(base) || base;
  // plural → singular heuristic (very light; domain parsers can override)
  const singular = mapped.endsWith('s') && !mapped.endsWith('ss') ? mapped.slice(0, -1) : mapped;
  return singular;
}

/**
 * Allow other modules to extend the synonym map at runtime.
 * @param {Record<string,string>} pairs - e.g., { "aubergine": "eggplant" }
 */
export function registerSynonyms(pairs = {}) {
  for (const [k, v] of Object.entries(pairs)) {
    if (typeof k === 'string' && typeof v === 'string' && k && v) {
      synonymMap.set(k.toLowerCase().trim(), v.toLowerCase().trim());
    }
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// Event helpers

function nowISO() {
  return new Date().toISOString();
}

function emit(type, data) {
  try {
    eventBus.emit('automation.event', {
      type,
      ts: nowISO(),
      source: SOURCE,
      data,
    });
  } catch {
    // fail silent — events should never crash the app
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// Public API

/**
 * Upsert a single nutrition entry.
 * @param {{ id:string, foodName:string, normalizedName?:string, lastUpdated?:string }} entry
 * @returns {Promise<{ok:boolean, id?:string, error?:string}>}
 */
export async function upsert(entry) {
  try {
    if (!entry || typeof entry !== 'object') {
      return { ok: false, error: 'Invalid entry' };
    }
    const id = stringOrNull(entry.id) || generateDeterministicId(entry.foodName);
    const foodName = stringOrNull(entry.foodName);
    if (!id || !foodName) {
      return { ok: false, error: 'Missing required fields: id and foodName' };
    }

    const normalizedName =
      stringOrNull(entry.normalizedName) || normalizeName(foodName);
    const lastUpdated = isISO(entry.lastUpdated) ? entry.lastUpdated : nowISO();

    const record = { id, foodName, normalizedName, lastUpdated };

    await db[TABLE].put(record);

    emit('nutrition.updated', { id, normalizedName, foodName });

    // NOTE: Not exporting to hub — this is reference data, not household mutation.
    // If you want to mirror nutrition catalog upstream, add exportToHubIfEnabled here.

    return { ok: true, id };
  } catch (err) {
    return { ok: false, error: err?.message || 'Upsert failed' };
  }
}

/**
 * Bulk upsert. Returns counts of inserted/updated.
 * @param {Array<{ id?:string, foodName:string, normalizedName?:string, lastUpdated?:string }>} items
 */
export async function bulkUpsert(items = []) {
  if (!Array.isArray(items) || items.length === 0) {
    return { ok: true, inserted: 0, updated: 0 };
  }
  const toPut = [];
  const ts = nowISO();
  for (const raw of items) {
    if (!raw || typeof raw !== 'object' || !raw.foodName) continue;
    const id = stringOrNull(raw.id) || generateDeterministicId(raw.foodName);
    const foodName = stringOrNull(raw.foodName);
    if (!id || !foodName) continue;
    const normalizedName =
      stringOrNull(raw.normalizedName) || normalizeName(foodName);
    const lastUpdated = isISO(raw.lastUpdated) ? raw.lastUpdated : ts;
    toPut.push({ id, foodName, normalizedName, lastUpdated });
  }
  if (toPut.length === 0) return { ok: true, inserted: 0, updated: 0 };

  // We want counts of inserted vs updated. Read existing ids first.
  const ids = toPut.map((r) => r.id);
  const existing = await db[TABLE].where('id').anyOf(ids).toArray();
  const existingSet = new Set(existing.map((r) => r.id));

  await db.transaction('rw', db[TABLE], async () => {
    await db[TABLE].bulkPut(toPut);
  });

  const updated = toPut.filter((r) => existingSet.has(r.id)).length;
  const inserted = toPut.length - updated;

  emit('nutrition.updated', { count: toPut.length, inserted, updated });
  return { ok: true, inserted, updated };
}

/**
 * Find exact by id.
 */
export async function getById(id) {
  if (!stringOrNull(id)) return null;
  return db[TABLE].get(id);
}

/**
 * Get by normalized name (exact).
 */
export async function getByNormalizedName(name) {
  const norm = normalizeName(name);
  if (!norm) return null;
  return db[TABLE].where('normalizedName').equals(norm).first();
}

/**
 * Lightweight search over foodName (case-insensitive contains).
 * @param {string} q
 * @param {number} limit
 */
export async function searchByFoodName(q, limit = 25) {
  const needle = (q || '').toLowerCase().trim();
  if (!needle) return [];
  // Use Dexie's filter for contains; for large catalogs consider an FTS index
  const all = await db[TABLE].where('foodName').startsWithIgnoreCase(needle).limit(limit).toArray();
  // If startsWith was too strict, fallback to full filter contains:
  if (all.length < limit / 2) {
    const alt = await db[TABLE].toArray();
    return alt
      .filter((r) => (r.foodName || '').toLowerCase().includes(needle))
      .slice(0, limit);
  }
  return all;
}

/**
 * Return every record (useful for debug/exports).
 */
export async function getAll() {
  return db[TABLE].toArray();
}

/**
 * Count records.
 */
export async function count() {
  return db[TABLE].count();
}

/**
 * Remove items not updated since cutoff ISO date.
 * @param {string} cutoffISO
 * @returns {{ok:boolean, removed:number}}
 */
export async function purgeStale(cutoffISO) {
  if (!isISO(cutoffISO)) return { ok: false, removed: 0 };
  let removed = 0;
  await db.transaction('rw', db[TABLE], async () => {
    const stale = await db[TABLE].where('lastUpdated').below(cutoffISO).toArray();
    const staleIds = stale.map((r) => r.id);
    if (staleIds.length) {
      await db[TABLE].bulkDelete(staleIds);
      removed = staleIds.length;
    }
  });
  if (removed > 0) emit('nutrition.updated', { removed, note: 'purgeStale' });
  return { ok: true, removed };
}

/**
 * Danger: clear the entire nutrition store.
 */
export async function clearAll() {
  await db[TABLE].clear();
  emit('nutrition.cleared', { ok: true });
  return { ok: true };
}

// ───────────────────────────────────────────────────────────────────────────────
// Utilities (single-use helpers)

/**
 * Create a deterministic id from a food name (stable across runs).
 * Use normalizedName as the base; prefix for future table splits if needed.
 */
function generateDeterministicId(foodName) {
  const norm = normalizeName(foodName);
  if (!norm) return null;
  // Simple hash to keep ids compact while avoiding collisions for common names.
  const h = djb2(norm);
  return `food:${norm}:${h}`;
}

/** djb2 string hash → hex (stable, tiny footprint) */
function djb2(str) {
  let hash = 5381;
  for (let i = 0; i < str.length; i += 1) {
    hash = ((hash << 5) + hash) ^ str.charCodeAt(i);
  }
  // ensure positive and convert to short hex
  return (hash >>> 0).toString(16);
}

function stringOrNull(v) {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

function isISO(v) {
  if (!v || typeof v !== 'string') return false;
  const d = new Date(v);
  return !Number.isNaN(d.getTime()) && /\d{4}-\d{2}-\d{2}T/.test(v);
}

// ───────────────────────────────────────────────────────────────────────────────
// Forward-looking extension points
//
// - Future tables: macro/micro-nutrients, portion sizes, brand UPC joins.
//   db.version(2).stores({ macros: 'id, foodId, ...', micros: 'id, foodId, ...' })
// - Consider a small FTS (full-text search) index if catalog grows large.
// - Hook into scrapers: when ImportRouter normalizes a new food, call bulkUpsert()
//   here; then let intelligence cache computed nutrition rollups per recipe.
// - If you later decide to mirror this catalog to the Hub, add exportToHubIfEnabled()
//   inside upsert()/bulkUpsert() with a derived payload (but keep this store as source of truth).

export default {
  upsert,
  bulkUpsert,
  getById,
  getByNormalizedName,
  searchByFoodName,
  getAll,
  count,
  purgeStale,
  clearAll,
  registerSynonyms,
};
