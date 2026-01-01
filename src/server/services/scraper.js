/**
 * @file C:\Users\larho\suka-smart-assistant\src\server\services\scraper.js
 *
 * Nutrition Scraper — scrapes a trusted public source (nutritionvalue.org) and
 * parses a nutrition table into a normalized JSON payload.
 *
 * PIPELINE FIT (imports → intelligence → automation → (optional) hub export)
 * - Called by nutritionService.scrapeNutritionIfMissing() when DB has no record.
 * - Returns a stable payload for central DB upsert (no household mutation here).
 * - Emits automation.event envelopes for observability/metrics.
 *
 * WHAT WE EXTRACT
 * - Calories
 * - Macros: protein, carbs, fat
 * - Micros: vitamin C, calcium, iron, potassium, magnesium, zinc
 * - `source` tag: "scraped:nutritionvalue.org"
 *
 * DEPENDENCIES
 * - Node 18+: global fetch. For older runtimes we soft-import node-fetch.
 * - cheerio for HTML parsing (server-side).
 *
 * RETURN SHAPE
 *   { ok: true, data: {
 *       normalizedName,
 *       displayName,
 *       source: 'scraped:nutritionvalue.org',
 *       macros: { calories, protein, carbs, fat },
 *       micros: { vitaminC, calcium, iron, potassium, magnesium, zinc },
 *       lastUpdated: <ISO>
 *     } }
 *   or { ok: false, error?: string }
 */

import eventBus from 'src/services/eventBus.js';
import * as cheerioPkg from 'cheerio';

const cheerio = cheerioPkg.default || cheerioPkg;

const SOURCE = 'server.services.scraper';
const PROVIDER = 'nutritionvalue.org';
const PROVIDER_TAG = `scraped:${PROVIDER}`;

// -----------------------------------------------------------------------------
// Public API

/**
 * Fetch nutrition data for a normalized or raw food name by scraping.
 * @param {string} normalizedName - canonical key (lowercase, ascii-only, no diacritics)
 * @param {string} [hint] - optional display name as a fallback for building search URLs
 * @returns {Promise<{ok:true, data:object} | {ok:false, error?:string}>}
 */
export async function fetchNutrition(normalizedName, hint) {
  const name = normalizeName(normalizedName || hint || '');
  if (!name) {
    emit('nutrition.scrape.error', { step: 'input', message: 'Invalid name' });
    return { ok: false, error: 'Invalid name' };
  }

  emit('nutrition.scrape.started', { provider: PROVIDER, normalizedName: name });

  // Build a small list of candidate URLs for best-effort scraping.
  const urls = buildCandidateUrls(name, hint);

  // Try each candidate until one yields a parseable page.
  for (let i = 0; i < urls.length; i += 1) {
    const url = urls[i];

    const html = await fetchHtml(url, { timeoutMs: 12000 });
    if (!html) {
      continue; // try next URL
    }

    const parsed = parseNutrition(html, { url, normalizedName: name, hint });
    if (parsed?.ok) {
      const data = {
        ...parsed.data,
        // finalize tags
        normalizedName: name,
        displayName: parsed.data.displayName || toTitleCase(name),
        source: PROVIDER_TAG,
        lastUpdated: new Date().toISOString(),
      };

      emit('nutrition.scrape.completed', {
        provider: PROVIDER,
        normalizedName: name,
        url,
        fields: Object.keys({ ...data.macros, ...data.micros }),
      });

      return { ok: true, data };
    }
  }

  emit('nutrition.scrape.error', { provider: PROVIDER, normalizedName: name, message: 'No parseable page' });
  return { ok: false, error: 'Unable to scrape nutrition data' };
}

// -----------------------------------------------------------------------------
// URL strategy (best-effort without hard-coding a single fragile path)

function buildCandidateUrls(normalizedName, hint) {
  // nutritionvalue typically uses hyphenated slugs with .html suffix in product pages
  // and also has a search endpoint we can try.
  const q = encodeURIComponent((hint || normalizedName).replace(/\s+/g, ' '));
  const slug = normalizedName.replace(/\s+/g, '-');

  const base = `https://${PROVIDER}`;
  const candidates = [
    `${base}/search.php?food_query=${q}`,
    `${base}/search.php?ingredient=${q}`,
    `${base}/product/${slug}.html`,
    `${base}/product/${slug}`,
  ];

  // Deduplicate while preserving order
  return [...new Set(candidates)];
}

// -----------------------------------------------------------------------------
// HTML fetch with timeout & minimal retry

async function fetchHtml(url, { timeoutMs = 12000, retries = 1 } = {}) {
  const f = await getFetch();
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const to = ac ? setTimeoutSafe(() => ac.abort(), timeoutMs) : null;
    try {
      const res = await f(url, {
        method: 'GET',
        headers: {
          'User-Agent': 'SSA/1.0 (+household-automation; compatible)',
          Accept: 'text/html,application/xhtml+xml',
        },
        signal: ac?.signal,
      });
      if (to) clearTimeout(to);
      if (!res.ok) {
        // Try next candidate on 404/500s
        continue;
      }
      const text = await res.text();
      if (text && text.length > 512) {
        return text;
      }
    } catch (err) {
      if (to) clearTimeout(to);
      // retry on network-ish errors
      if (attempt < retries && isNetworkLike(err)) {
        await delay(300 * (attempt + 1));
        continue;
      }
    }
  }
  return null;
}

// -----------------------------------------------------------------------------
// Parser (cheerio): attempt to find common nutrition table patterns

/**
 * Parse nutrition HTML for macros/micros.
 * @param {string} html
 * @param {{ url: string, normalizedName: string, hint?: string }} ctx
 * @returns {{ok:true, data:object} | {ok:false}}
 */
function parseNutrition(html, ctx) {
  try {
    const $ = cheerio.load(html);

    // Try to find a heading/title for display.
    const title =
      $('h1').first().text().trim() ||
      $('title').first().text().trim().replace(/\s*\|\s*NutritionValue.*$/i, '') ||
      '';

    // Strategy:
    // 1) Look for a table where first column is nutrient name and second is value (per 100g or per serving)
    // 2) Normalize keys and collect
    const candidates = findLikelyTables($);

    let macros = { calories: null, protein: null, carbs: null, fat: null };
    let micros = { vitaminC: null, calcium: null, iron: null, potassium: null, magnesium: null, zinc: null };

    for (const table of candidates) {
      const rows = $(table).find('tr');
      rows.each((_, tr) => {
        const cols = $(tr).find('th,td');
        if (cols.length < 2) return;
        const key = normalizeKey($(cols[0]).text());
        const val = normalizeValue($(cols[1]).text());

        if (!key || val == null) return;

        // Map keys to fields
        if (keyMatch(key, ['calories', 'energy'])) macros.calories = preferNumber(macros.calories, val);
        else if (keyMatch(key, ['protein'])) macros.protein = preferNumber(macros.protein, val);
        else if (keyMatch(key, ['carbohydrate', 'carbohydrates', 'carbs'])) macros.carbs = preferNumber(macros.carbs, val);
        else if (keyMatch(key, ['fat', 'total fat'])) macros.fat = preferNumber(macros.fat, val);
        else if (keyMatch(key, ['vitamin c', 'ascorbic acid'])) micros.vitaminC = preferNumber(micros.vitaminC, val);
        else if (keyMatch(key, ['calcium'])) micros.calcium = preferNumber(micros.calcium, val);
        else if (keyMatch(key, ['iron'])) micros.iron = preferNumber(micros.iron, val);
        else if (keyMatch(key, ['potassium'])) micros.potassium = preferNumber(micros.potassium, val);
        else if (keyMatch(key, ['magnesium'])) micros.magnesium = preferNumber(micros.magnesium, val);
        else if (keyMatch(key, ['zinc'])) micros.zinc = preferNumber(micros.zinc, val);
      });
    }

    // If nothing found, return not ok to try next URL.
    const anyFound =
      hasNumber(macros.calories) ||
      hasNumber(macros.protein) ||
      hasNumber(macros.carbs) ||
      hasNumber(macros.fat) ||
      Object.values(micros).some(hasNumber);

    if (!anyFound) {
      return { ok: false };
    }

    // Round to sensible decimals
    macros = roundMacros(macros);
    micros = roundMicros(micros);

    const data = {
      displayName: title || toTitleCase(ctx.normalizedName),
      macros,
      micros,
    };

    return { ok: true, data };
  } catch {
    return { ok: false };
  }
}

// Find table candidates with many rows and nutrient-ish keys
function findLikelyTables($) {
  const tables = $('table').toArray();
  // Rank by number of rows and presence of strings such as "Calories", "Protein" etc.
  const ranked = tables
    .map((t) => {
      const text = $(t).text().toLowerCase();
      const score =
        (text.includes('calorie') ? 3 : 0) +
        (text.includes('protein') ? 2 : 0) +
        (text.includes('carbo') ? 2 : 0) +
        (text.includes('fat') ? 1 : 0) +
        $(t).find('tr').length / 10;
      return { t, score };
    })
    .filter((x) => x.score > 1)
    .sort((a, b) => b.score - a.score);

  return ranked.map((x) => x.t);
}

// -----------------------------------------------------------------------------
// Normalizers & helpers

function normalizeName(name) {
  const s = String(name || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^a-z0-9\s\-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return s.replace(/s$/, ''); // light plural→singular
}

function normalizeKey(k) {
  return String(k || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function normalizeValue(v) {
  if (!v) return null;
  const s = String(v).toLowerCase();

  // Prefer numbers in g/mg/kcal cells; strip units
  // Examples: "12 g", "31.5g", "215 kcal", "0.8 mg", "2,345 mg"
  const m = s.replace(/,/g, '').match(/-?\d+(\.\d+)?/);
  if (!m) return null;
  const n = parseFloat(m[0]);
  if (!Number.isFinite(n)) return null;

  // Heuristics for kcal vs grams vs milligrams:
  if (s.includes('kcal')) return n; // calories
  if (s.includes('cal') && !s.includes('kcal')) return n; // sometimes "calories"
  if (s.includes('mg')) return n / 1000; // convert mg → g
  // else assume grams
  return n;
}

function keyMatch(key, variants) {
  return variants.some((v) => key.includes(v));
}

function preferNumber(existing, nextVal) {
  if (hasNumber(existing)) return existing;
  return nextVal;
}
function hasNumber(x) {
  return typeof x === 'number' && Number.isFinite(x);
}

function roundMacros(m) {
  const r = {};
  r.calories = hasNumber(m.calories) ? Math.round(m.calories) : null;
  r.protein = hasNumber(m.protein) ? round1(m.protein) : null;
  r.carbs = hasNumber(m.carbs) ? round1(m.carbs) : null;
  r.fat = hasNumber(m.fat) ? round1(m.fat) : null;
  return r;
}
function roundMicros(mi) {
  const r = {};
  for (const [k, v] of Object.entries(mi)) {
    r[k] = hasNumber(v) ? round2(v) : null;
  }
  return r;
}
function round1(n) {
  return Math.round(n * 10) / 10;
}
function round2(n) {
  return Math.round(n * 100) / 100;
}

function toTitleCase(s) {
  return String(s || '')
    .split(' ')
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : ''))
    .join(' ');
}

// -----------------------------------------------------------------------------
// fetch/polyfill & small utils

async function getFetch() {
  if (typeof fetch !== 'undefined') return fetch;
  try {
    const nf = await import(/* @vite-ignore */ 'node-fetch');
    return (nf.default || nf);
  } catch {
    throw new Error('No fetch() available in this runtime');
  }
}

function isNetworkLike(err) {
  const msg = (err?.message || '').toLowerCase();
  return msg.includes('network') || msg.includes('timeout') || msg.includes('abort') || msg.includes('failed to fetch');
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function setTimeoutSafe(fn, ms) {
  const id = setTimeout(fn, ms);
  // @ts-ignore
  if (typeof id.unref === 'function') id.unref();
  return id;
}

function emit(type, data) {
  try {
    eventBus.emit('automation.event', {
      type,
      ts: new Date().toISOString(),
      source: SOURCE,
      data,
    });
  } catch {
    // never throw from telemetry
  }
}

// -----------------------------------------------------------------------------
// Default export (named + default to be flexible)
export default { fetchNutrition };
