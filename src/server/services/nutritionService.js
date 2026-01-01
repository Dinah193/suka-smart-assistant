/**
 * @file C:\Users\larho\suka-smart-assistant\src\server\services\nutritionService.js
 *
 * Central Nutrition Service — DB lookups and scrape-on-miss with persistence.
 *
 * HOW THIS FITS THE SSA PIPELINE
 * imports → normalize → intelligence → automation → (optional) hub export
 * - Frontend asks the server routes (/server/routes/nutrition.js) for nutrition.
 * - Those routes call into this service to:
 *    1) getNutritionFromDB({ id?, name? })
 *    2) scrapeNutritionIfMissing({ normalizedName, hint?, force? })
 * - This mutates the **central catalog**, not household data; no Hub export here.
 *
 * EVENTS (automation.event envelopes with ISO timestamps):
 *   nutrition.db.lookup.hit
 *   nutrition.db.lookup.miss
 *   nutrition.db.lookup.error
 *   nutrition.db.upsert.ok
 *   nutrition.db.upsert.error
 *   nutrition.scrape.started
 *   nutrition.scrape.completed
 *   nutrition.scrape.queued
 *   nutrition.scrape.skipped
 *   nutrition.scrape.error
 */

import crypto from 'crypto';
import eventBus from 'src/services/eventBus.js';

// Soft-select a DB adapter at runtime (Postgres, Mongo, or a generic adapter).
const pgAdapter = await softImport('src/server/db/adapters/nutrition.pg.js');
const mongoAdapter = await softImport('src/server/db/adapters/nutrition.mongo.js');
const genericService = await softImport('src/server/services/NutritionDB.js'); // legacy or generic

// Soft-select a scraper implementation.
//  A) src/server/scrapers/nutritionScraper.js  → { fetchNutrition(name, hint?) }
//  B) src/server/services/ScraperOrchestrator.js → { enqueueNutritionJob({ normalizedName, hint }) }
const scraper = await softImport('src/server/scrapers/nutritionScraper.js');
const orchestrator = await softImport('src/server/services/ScraperOrchestrator.js');

const SOURCE = 'server.services.nutrition';

// ───────────────────────────────────────────────────────────────────────────────
// Public API

/**
 * Lookup a nutrition record by id or name.
 * @param {{ id?: string, name?: string }} params
 * @returns {Promise<{ ok: boolean, data: object|null }>}
 */
export async function getNutritionFromDB(params = {}) {
  try {
    const { id, name } = sanitizeLookup(params);

    if (!id && !name) {
      return { ok: false, data: null };
    }

    const adapter = pickAdapter();

    let out = null;
    if (id) out = await safeCall(() => adapter.getById(id));
    if (!out?.data && name) out = await safeCall(() => adapter.getByName(normalizeName(name)));

    if (out?.ok && out.data) {
      emit('nutrition.db.lookup.hit', { id, name: name || undefined, idOrName: id || name });
      return { ok: true, data: out.data };
    }

    emit('nutrition.db.lookup.miss', { id, name: name || undefined });
    return { ok: true, data: null };
  } catch (err) {
    emit('nutrition.db.lookup.error', { message: err?.message || 'lookup failed' });
    return { ok: false, data: null };
  }
}

/**
 * Scrape nutrition if missing. If a synchronous scraper returns data, it is
 * validated and persisted, then returned. If an async orchestrator is available,
 * a job is queued and a {queued, jobId} response is returned.
 *
 * @param {{ normalizedName: string, hint?: string, force?: boolean }} params
 * @returns {Promise<
 *   | { ok: true, data: object }
 *   | { queued: true, jobId?: string }
 *   | { ok: false }
 * >}
 */
export async function scrapeNutritionIfMissing(params = {}) {
  const normalizedName = normalizeName(params?.normalizedName || '');
  const hint = stringOrNull(params?.hint);
  const force = !!params?.force;

  if (!normalizedName) {
    return { ok: false };
  }

  // If not forced, check DB first
  if (!force) {
    const existing = await getNutritionFromDB({ name: normalizedName });
    if (existing?.ok && existing.data) {
      emit('nutrition.scrape.skipped', { normalizedName, reason: 'ALREADY_EXISTS' });
      return { ok: true, data: existing.data };
    }
  }

  emit('nutrition.scrape.started', { normalizedName, hint });

  // Prefer a synchronous scraper (fast path)
  if (scraper?.fetchNutrition && typeof scraper.fetchNutrition === 'function') {
    try {
      const r = await scraper.fetchNutrition(normalizedName, hint || undefined);
      if (r?.ok && r.data) {
        const valid = validateNutritionPayload(r.data, normalizedName);
        if (!valid.ok) {
          emit('nutrition.scrape.error', { normalizedName, reason: 'INVALID_PAYLOAD', detail: valid.error });
          return { ok: false };
        }

        // Persist
        const saved = await upsertNutrition(valid.data);
        if (!saved.ok) {
          emit('nutrition.db.upsert.error', { normalizedName, message: saved.error || 'upsert failed' });
          return { ok: false };
        }

        emit('nutrition.scrape.completed', { normalizedName, id: saved.id });
        return { ok: true, data: valid.data };
      }
    } catch (err) {
      emit('nutrition.scrape.error', {
        normalizedName,
        reason: 'SCRAPER_THROW',
        message: err?.message || 'scraper failed',
      });
      // Fall through to orchestrator attempt
    }
  }

  // Fallback: queue a job with orchestrator
  if (orchestrator?.enqueueNutritionJob && typeof orchestrator.enqueueNutritionJob === 'function') {
    try {
      const queued = await orchestrator.enqueueNutritionJob({ normalizedName, hint: hint || undefined });
      emit('nutrition.scrape.queued', { normalizedName, jobId: queued?.jobId });
      return { queued: true, jobId: queued?.jobId };
    } catch (err) {
      emit('nutrition.scrape.error', {
        normalizedName,
        reason: 'QUEUE_THROW',
        message: err?.message || 'queue failed',
      });
      return { ok: false };
    }
  }

  emit('nutrition.scrape.skipped', { normalizedName, reason: 'NO_SCRAPER_AVAILABLE' });
  return { ok: false };
}

// ───────────────────────────────────────────────────────────────────────────────
// Internal: persistence

/**
 * Upsert a nutrition record via the selected adapter.
 * The adapter should handle either:
 *  - Postgres: INSERT ... ON CONFLICT DO UPDATE
 *  - Mongo: findOneAndUpdate({id}, {$set: doc}, {upsert:true})
 *
 * @param {object} doc - validated nutrition doc
 * @returns {Promise<{ok:boolean, id?:string, error?:string}>}
 */
async function upsertNutrition(doc) {
  try {
    const adapter = pickAdapter();
    const result = await safeCall(() => adapter.upsert(doc));
    if (result?.ok) {
      emit('nutrition.db.upsert.ok', { id: result.id, normalizedName: doc.normalizedName });
      return { ok: true, id: result.id };
    }
    return { ok: false, error: 'adapter upsert failed' };
  } catch (err) {
    return { ok: false, error: err?.message || 'upsert error' };
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// Adapter selection

function pickAdapter() {
  // Priority: explicit adapter files first, then a generic service shim.
  if (pgAdapter?.getById && pgAdapter?.getByName && pgAdapter?.upsert) return pgAdapter;
  if (mongoAdapter?.getById && mongoAdapter?.getByName && mongoAdapter?.upsert) return mongoAdapter;

  if (genericService) {
    // Provide a small shim over the generic service shape:
    // Expect genericService to expose: getById(id), getByName(name), upsert(doc)
    const s = genericService;
    return {
      getById: (id) => s.getById(id),
      getByName: (name) => (s.getByName ? s.getByName(name) : s.getById(generateIdFromName(name))),
      upsert: (doc) => (s.upsert ? s.upsert(doc) : s.save(doc)),
    };
  }

  // Minimal no-op adapter to avoid crashes (returns nulls)
  return {
    async getById() {
      return { ok: true, data: null };
    },
    async getByName() {
      return { ok: true, data: null };
    },
    async upsert() {
      return { ok: false };
    },
  };
}

// ───────────────────────────────────────────────────────────────────────────────
// Validation & utilities

/**
 * Normalize and validate a nutrition payload; ensure it has a stable id.
 * Minimal schema:
 *   {
 *     id?: string,
 *     normalizedName: string,
 *     displayName?: string,
 *     source?: string,
 *     macros?: { calories?: number, protein?: number, fat?: number, carbs?: number },
 *     micros?: Record<string, number>,
 *     lastUpdated?: ISO string
 *   }
 */
function validateNutritionPayload(incoming, fallbackName) {
  try {
    const data = { ...(incoming || {}) };

    data.normalizedName = normalizeName(data.normalizedName || fallbackName || '');
    if (!data.normalizedName) {
      return { ok: false, error: 'missing normalizedName' };
    }

    // Ensure id is deterministic when not supplied
    data.id = stringOrNull(data.id) || generateIdFromName(data.normalizedName);

    // Basic field coercions
    if (!isPlainObject(data.macros)) data.macros = {};
    if (!isPlainObject(data.micros)) data.micros = {};
    if (!isISO(data.lastUpdated)) data.lastUpdated = now();

    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: err?.message || 'validation error' };
  }
}

function sanitizeLookup({ id, name }) {
  return {
    id: stringOrNull(id),
    name: stringOrNull(name),
  };
}

function normalizeName(name) {
  return String(name || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^a-z0-9\s\-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/s$/, ''); // light plural→singular
}

function generateIdFromName(normalizedName) {
  const base = normalizeName(normalizedName);
  const hash = sha1(base);
  return `food:${base}:${hash}`;
}

function sha1(str) {
  return crypto.createHash('sha1').update(String(str)).digest('hex');
}

function isPlainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

function isISO(v) {
  if (!v || typeof v !== 'string') return false;
  const t = Date.parse(v);
  return Number.isFinite(t);
}

function now() {
  return new Date().toISOString();
}

function stringOrNull(v) {
  const s = typeof v === 'string' ? v.trim() : '';
  return s ? s : null;
}

function emit(type, data) {
  try {
    eventBus.emit('automation.event', {
      type,
      ts: now(),
      source: SOURCE,
      data,
    });
  } catch {
    // never throw from telemetry
  }
}

async function softImport(path) {
  try {
    const mod = await import(/* @vite-ignore */ path);
    return mod?.default || mod;
  } catch {
    return null;
  }
}

async function safeCall(fn) {
  try {
    const r = await fn();
    // Normalize adapter outputs: allow returning raw doc or {ok,data}
    if (r && r.ok !== undefined) return r;
    if (r && typeof r === 'object') return { ok: true, data: r };
    return { ok: true, data: null };
  } catch (err) {
    return { ok: false, data: null, error: err?.message };
  }
}

// ───────────────────────────────────────────────────────────────────────────────
export default {
  getNutritionFromDB,
  scrapeNutritionIfMissing,
};
