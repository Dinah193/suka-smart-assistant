// C:\Users\larho\suka-smart-assistant\src\services\scraper\ScraperEngine.js
/**
 * ScraperEngine — Universal scraper for SSA
 * ------------------------------------------------------------
 * ROLE IN PIPELINE
 * imports (fetch/scrape) → intelligence (normalize/enrich) → automation (emit events) → (optional) hub export
 *
 * WHAT THIS FILE DOES
 * - Fetches a remote URL (optionally via proxy) and extracts:
 *   * HTML + plaintext (readable main content)
 *   * Tables (HTML <table> → arrays of rows with header mapping)
 *   * Links, images, OpenGraph/Twitter cards
 *   * schema.org JSON-LD (Recipe, HowTo, Product, VideoObject, etc.)
 * - Guesses importType (recipe/cleaning/garden/animal/storehouse/video) from metadata
 * - Emits eventBus notifications with a consistent payload shape: { type, ts, source, data }
 * - Provides a lightweight plugin system to register per-domain/per-type extractors
 * - Soft-integrates with an import cache if available (does not hard-require it)
 * - Provides a silent Hub export helper for future data-changing flows
 *
 * WHAT THIS FILE DOES *NOT* DO
 * - It does not mutate household state (inventory/storehouse/sessions). Downstream parsers will.
 *   Therefore, we DO NOT call exportToHubIfEnabled() here by default.
 *
 * EXTENSION POINTS
 * - registerExtractor({ id, test(url, doc, meta), extract({ url, html, doc, meta }) })
 *   to add domain-specific scraping logic (e.g., Allrecipes, YouTube, Pinterest, seed vendors)
 *
 * EVENTS EMITTED
 * - scrape.started
 * - scrape.completed  (success or failure)
 * - import.cached     (only if a cache service is available and persist=true)
 *
 * ERROR HANDLING
 * - Defensive guards; early returns for invalid input
 * - Timeouts and retry logic for fetch
 * - CORS-safe options (proxy usage)
 */

import eventBus from '../eventBus.js';

// Soft imports (optional). If missing, features degrade gracefully.
let featureFlags = { familyFundMode: false };
let HubPacketFormatter = null;
let FamilyFundConnector = null;
let ImportCacheService = null;
let siteAllowList = null;

(async () => {
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
  try {
    const mod = await import('../../services/imports/ImportCacheService.js');
    ImportCacheService = mod.default || mod;
  } catch {}
  try {
    const mod = await import('../../config/siteAllowList.json', { assert: { type: 'json' } });
    siteAllowList = mod.default || mod;
  } catch {}
})();

// Runtime utilities ----------------------------------------------------------

const SOURCE = 'ScraperEngine';

const nowISO = () => new Date().toISOString();

const emit = (type, data) => {
  eventBus.emit({
    type,
    ts: nowISO(),
    source: SOURCE,
    data,
  });
};

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

/**
 * Fetch with timeout + retry. Uses browser fetch; if running under Node,
 * callers should ensure a fetch polyfill is available.
 */
async function fetchWithRetry(url, { timeoutMs = 15000, retries = 1, retryDelayMs = 600, headers = {}, proxy } = {}) {
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), timeoutMs);

  const targetUrl = proxy ? `${proxy}${encodeURIComponent(url)}` : url;

  try {
    const res = await fetch(targetUrl, {
      method: 'GET',
      headers,
      signal: controller.signal,
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'follow',
    });
    clearTimeout(tid);
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status} for ${url}`);
      err.status = res.status;
      throw err;
    }
    const contentType = res.headers.get('content-type') || '';
    const text = await res.text();
    return { text, contentType, status: res.status };
  } catch (err) {
    clearTimeout(tid);
    if (retries > 0) {
      await sleep(retryDelayMs);
      return fetchWithRetry(url, { timeoutMs, retries: retries - 1, retryDelayMs: retryDelayMs * 2, headers, proxy });
    }
    throw err;
  }
}

/**
 * Safely build a DOM in browser or in Node (if jsdom is available).
 */
async function toDOM(html) {
  // Browser path
  if (typeof window !== 'undefined' && typeof window.DOMParser !== 'undefined') {
    const parser = new window.DOMParser();
    return parser.parseFromString(html, 'text/html');
  }
  // Node path (optional)
  try {
    const { JSDOM } = await import('jsdom');
    return new JSDOM(html).window.document;
  } catch {
    return null; // No DOM available in this environment
  }
}

/**
 * Basic readability heuristic that:
 * - removes script/noscript/style
 * - picks the largest <article|main|section|div> by text length as main
 * - returns textContent and innerHTML for that node
 */
function extractReadable(doc) {
  if (!doc) return { text: '', html: '' };

  // Remove noise
  ['script', 'noscript', 'style', 'iframe', 'svg'].forEach((sel) =>
    doc.querySelectorAll(sel).forEach((n) => n.remove())
  );

  const candidates = [...doc.querySelectorAll('article, main, section, div')];

  let best = null;
  let bestScore = 0;

  for (const node of candidates) {
    const text = node.textContent || '';
    const len = text.trim().length;
    // Penalize if it looks like nav/footer/aside
    const role = node.getAttribute('role') || '';
    const id = node.id || '';
    const cls = node.className || '';
    const penalized =
      /nav|footer|header|aside|menu|promo|breadcrumb|subscribe|newsletter/i.test(role + ' ' + id + ' ' + cls);

    const score = penalized ? Math.floor(len * 0.25) : len;
    if (score > bestScore) {
      bestScore = score;
      best = node;
    }
  }

  if (!best) {
    const body = doc.body || doc.documentElement;
    return { text: (body && body.textContent) || '', html: (body && body.innerHTML) || '' };
  }

  return {
    text: (best.textContent || '').replace(/\s+\n/g, '\n').trim(),
    html: best.innerHTML || '',
  };
}

/**
 * Extract JSON-LD blobs and parse the ones with @type we care about.
 */
function extractJSONLD(doc) {
  if (!doc) return [];
  const scripts = [...doc.querySelectorAll('script[type="application/ld+json"]')];
  const out = [];
  for (const s of scripts) {
    const raw = s.textContent || '';
    if (!raw.trim()) continue;
    try {
      const json = JSON.parse(raw);
      // Compact arrays/graphs
      if (Array.isArray(json)) {
        out.push(...json);
      } else if (json['@graph']) {
        out.push(...json['@graph']);
      } else {
        out.push(json);
      }
    } catch {
      // ignore bad JSON-LD
    }
  }
  return out;
}

/**
 * Extract OpenGraph and Twitter Card metadata.
 */
function extractCards(doc) {
  if (!doc) return { og: {}, twitter: {} };
  const byProp = (prop) =>
    [...doc.querySelectorAll(`meta[property="${prop}"],meta[name="${prop}"]`)]
      .map((m) => m.getAttribute('content'))
      .filter(Boolean)[0];

  return {
    og: {
      title: byProp('og:title'),
      description: byProp('og:description'),
      image: byProp('og:image'),
      type: byProp('og:type'),
      url: byProp('og:url'),
      site_name: byProp('og:site_name'),
    },
    twitter: {
      card: byProp('twitter:card'),
      title: byProp('twitter:title'),
      description: byProp('twitter:description'),
      image: byProp('twitter:image'),
      site: byProp('twitter:site'),
      creator: byProp('twitter:creator'),
    },
  };
}

/**
 * Extract all <table> elements into structured arrays with headers.
 */
function extractTables(doc) {
  if (!doc) return [];
  const results = [];

  const tables = [...doc.querySelectorAll('table')];
  for (const table of tables) {
    const headers = [];
    const headerRow =
      table.querySelector('thead tr') || table.querySelector('tr'); // try thead first, fallback to first row
    if (headerRow) {
      [...headerRow.querySelectorAll('th,td')].forEach((cell, idx) => {
        const txt = (cell.textContent || '').trim();
        headers[idx] = txt || `col_${idx + 1}`;
      });
    }

    const bodyRows =
      table.querySelectorAll('tbody tr').length > 0 ? [...table.querySelectorAll('tbody tr')] : [...table.querySelectorAll('tr')].slice(1);

    const rows = bodyRows.map((tr) => {
      const obj = {};
      const cells = [...tr.querySelectorAll('td,th')];
      cells.forEach((cell, idx) => {
        const key = headers[idx] || `col_${idx + 1}`;
        obj[key] = (cell.textContent || '').trim();
      });
      return obj;
    });

    // Skip empty tables
    const nonEmpty = rows.some((r) => Object.values(r).some((v) => v));
    if (!nonEmpty) continue;

    results.push({
      header: headers,
      rows,
      approxSize: rows.length,
    });
  }

  return results;
}

/**
 * Extract basic document meta (title, description).
 */
function extractBasicMeta(doc) {
  if (!doc) return { title: '', description: '' };
  const title = (doc.querySelector('title') && doc.querySelector('title').textContent) || '';
  const desc =
    (doc.querySelector('meta[name="description"]') &&
      doc.querySelector('meta[name="description"]').getAttribute('content')) ||
    '';
  return { title: title.trim(), description: (desc || '').trim() };
}

/**
 * Extract links, images (basic), for heuristic type detection or downstream uses.
 */
function extractLinksAndImages(doc) {
  if (!doc) return { links: [], images: [] };
  const links = [...doc.querySelectorAll('a[href]')]
    .map((a) => ({ href: a.getAttribute('href'), text: (a.textContent || '').trim() }))
    .filter((l) => l.href && !l.href.startsWith('javascript:'));

  const images = [...doc.querySelectorAll('img[src]')].map((img) => ({
    src: img.getAttribute('src'),
    alt: img.getAttribute('alt') || '',
  }));

  return { links, images };
}

/**
 * Guess an importType from JSON-LD and content signals.
 */
function guessImportType({ jsonld, og, twitter, text }) {
  const str = `${JSON.stringify(jsonld)} ${og?.type || ''} ${twitter?.card || ''} ${text || ''}`.toLowerCase();

  if (/\brecipe\b/.test(str)) return 'recipe';
  if (/\bhowto\b/.test(str)) return 'cleaning'; // treat HowTo as a procedure; downstream may refine
  if (/\bproduct\b/.test(str) || /\baggregateoffer\b/.test(str)) return 'storehouse';
  if (/\bvideoobject\b/.test(str)) return 'video';
  if (/\banimal\b|\bbutchery|\bslaughter\b|\bgoat\b|\blamb\b|\bcow\b|\bduck\b/.test(str)) return 'animal';
  if (/\bseed\b|\bgermination\b|\bplanting\b|\bzone\b|\bharvest\b|\bsoil\b/.test(str)) return 'garden';

  // Heuristic fallback using keywords
  if (/\bclean|sanitize|disinfect|deodorize|aromatic|essential oil\b/.test(str)) return 'cleaning';
  if (/\bcan(ning)?\b|\bdehydration\b|\bferment(ation)?\b|\bbrine\b|\bpickle\b/.test(str)) return 'preservation';

  return 'unknown';
}

/**
 * Optional hub export helper (not used here by default).
 */
async function exportToHubIfEnabled(payload) {
  try {
    if (!featureFlags?.familyFundMode) return;
    if (!HubPacketFormatter || !FamilyFundConnector) return;
    const packet = HubPacketFormatter.format(payload);
    await FamilyFundConnector.send(packet);
  } catch {
    // fail silently by design
  }
}

/**
 * Optional allow-list enforcement.
 */
function isAllowedByList(urlStr) {
  if (!siteAllowList || !Array.isArray(siteAllowList?.domains) || siteAllowList.domains.length === 0) return true;
  try {
    const u = new URL(urlStr);
    const host = u.hostname.toLowerCase();
    return siteAllowList.domains.some((d) => host === d || host.endsWith(`.${d}`));
  } catch {
    return false;
  }
}

// Extractor plugin system ----------------------------------------------------

const _extractors = new Map();
/**
 * Register a custom extractor plugin:
 * {
 *   id: 'allrecipes',
 *   test: (url, doc, meta) => boolean,
 *   extract: async ({ url, html, doc, meta }) => ({ enriched fields })
 * }
 */
export function registerExtractor(plugin) {
  if (!plugin || !plugin.id || typeof plugin.test !== 'function' || typeof plugin.extract !== 'function') {
    throw new Error('Invalid extractor plugin shape.');
  }
  _extractors.set(plugin.id, plugin);
}

export function unregisterExtractor(id) {
  _extractors.delete(id);
}

export function listExtractors() {
  return [..._extractors.keys()];
}

// Main Scrape API ------------------------------------------------------------

/**
 * scrape(url, options)
 * - Fetches and extracts content
 * - Returns a normalized payload
 * - Emits scrape.started and scrape.completed
 *
 * options:
 * {
 *   proxy?: string,                // e.g., '/api/proxy?url=' to bypass CORS
 *   timeoutMs?: number,            // default 15000
 *   retries?: number,              // default 1
 *   headers?: object,              // custom request headers
 *   persist?: boolean,             // if true and ImportCacheService exists, cache result
 *   allowListEnforced?: boolean,   // default false; enforce siteAllowList.json
 * }
 */
export async function scrape(url, options = {}) {
  const startedAt = nowISO();

  // Basic input validation
  if (typeof url !== 'string' || url.length < 8) {
    const err = new Error('scrape() requires a valid URL string.');
    emit('scrape.completed', { url, ok: false, startedAt, finishedAt: nowISO(), error: err.message });
    throw err;
  }

  if (options.allowListEnforced && !isAllowedByList(url)) {
    const err = new Error('URL is not in the allowed domains list.');
    emit('scrape.completed', { url, ok: false, startedAt, finishedAt: nowISO(), error: err.message });
    throw err;
  }

  emit('scrape.started', { url, startedAt });

  // Fetch
  let html, contentType, status;
  try {
    const result = await fetchWithRetry(url, {
      timeoutMs: options.timeoutMs ?? 15000,
      retries: options.retries ?? 1,
      headers: options.headers || {},
      proxy: options.proxy,
    });
    html = result.text;
    contentType = result.contentType || '';
    status = result.status;
  } catch (error) {
    emit('scrape.completed', { url, ok: false, startedAt, finishedAt: nowISO(), error: error.message });
    throw error;
  }

  // Only HTML is supported here; non-HTML could be handled by future plugins
  if (!/text\/html|application\/xhtml\+xml/i.test(contentType)) {
    const payload = {
      url,
      fetchedAt: nowISO(),
      status,
      contentType,
      html: '',
      text: '',
      tables: [],
      meta: {},
      og: {},
      twitter: {},
      jsonld: [],
      links: [],
      images: [],
      type: 'unknown',
      extractor: null,
    };
    emit('scrape.completed', { url, ok: true, startedAt, finishedAt: nowISO(), data: summarizePayload(payload) });
    if (options.persist && ImportCacheService && typeof ImportCacheService.save === 'function') {
      await persistImportCacheSafe(payload);
    }
    return payload;
  }

  // Build DOM
  const doc = await toDOM(html);

  // Core extraction
  const basic = extractBasicMeta(doc);
  const cards = extractCards(doc);
  const jsonld = extractJSONLD(doc);
  const { text, html: mainHTML } = extractReadable(doc);
  const tables = extractTables(doc);
  const { links, images } = extractLinksAndImages(doc);

  const meta = {
    ...basic,
    fetchedAt: nowISO(),
    sourceUrl: url,
  };

  // Try registered extractors
  let extractorId = null;
  let extractedEnrichment = {};
  for (const plugin of _extractors.values()) {
    let match = false;
    try {
      match = !!plugin.test(url, doc, { basic, cards, jsonld });
    } catch {
      match = false;
    }
    if (match) {
      extractorId = plugin.id;
      try {
        extractedEnrichment = (await plugin.extract({ url, html, doc, meta: { basic, cards, jsonld } })) || {};
      } catch {
        extractedEnrichment = {};
      }
      break;
    }
  }

  const type = guessImportType({
    jsonld,
    og: cards.og,
    twitter: cards.twitter,
    text,
  });

  const payload = {
    url,
    fetchedAt: meta.fetchedAt,
    status,
    contentType,
    html, // full HTML (consider trimming or omitting in production if size is a concern)
    main: {
      html: mainHTML,
      text,
    },
    tables,
    meta: basic,
    og: cards.og,
    twitter: cards.twitter,
    jsonld,
    links,
    images,
    type, // best-effort guess for downstream ImportRouter/Normalizers
    extractor: extractorId, // which plugin enriched this content, if any
    enrichment: extractedEnrichment, // domain-specific extras (e.g., canonical ingredients table)
  };

  // Emit completion
  emit('scrape.completed', { url, ok: true, startedAt, finishedAt: nowISO(), data: summarizePayload(payload) });

  // Optional cache
  if (options.persist && ImportCacheService && typeof ImportCacheService.save === 'function') {
    await persistImportCacheSafe(payload);
  }

  return payload;
}

// Helpers --------------------------------------------------------------------

function summarizePayload(payload) {
  // Keep event payload lean to avoid large bus traffic
  return {
    url: payload.url,
    fetchedAt: payload.fetchedAt,
    status: payload.status,
    contentType: payload.contentType,
    type: payload.type,
    extractor: payload.extractor,
    mainTextPreview: (payload.main?.text || '').slice(0, 180),
    tablesCount: payload.tables?.length || 0,
    imagesCount: payload.images?.length || 0,
    jsonldCount: payload.jsonld?.length || 0,
  };
}

async function persistImportCacheSafe(payload) {
  try {
    const key = `${payload.url}::${payload.fetchedAt}`;
    await ImportCacheService.save(key, {
      url: payload.url,
      fetchedAt: payload.fetchedAt,
      status: payload.status,
      contentType: payload.contentType,
      type: payload.type,
      meta: payload.meta,
      og: payload.og,
      twitter: payload.twitter,
      jsonld: payload.jsonld,
      main: payload.main,
      tables: payload.tables,
      links: payload.links,
      images: payload.images,
      extractor: payload.extractor,
      enrichment: payload.enrichment,
      // NOTE: We deliberately do NOT store full HTML by default to keep cache smaller.
      // If you need it, toggle below:
      // html: payload.html,
    });
    emit('import.cached', { url: payload.url, key, type: payload.type, ts: nowISO() });
  } catch {
    // ignore cache errors
  }
}

// Default export -------------------------------------------------------------

const ScraperEngine = {
  scrape,
  registerExtractor,
  unregisterExtractor,
  listExtractors,
};

export default ScraperEngine;

/**
 * DEV NOTES / FUTURE:
 * - Consider adding a workerized path for large pages to avoid main-thread blocking.
 * - Add binary handling (PDF/image OCR) via specialized plugins and screenshot tool.
 * - Add source-specific anti-bot handling (headers, randomized UA) behind feature flags.
 * - Add per-domain rate limiting via a small token bucket to avoid hammering.
 * - Integrate a “content hash” to dedupe cache entries.
 * - When a downstream normalizer mutates household data, it should invoke exportToHubIfEnabled().
 */
