// C:\Users\larho\suka-smart-assistant\src\services\scraper\ScraperAdapters.js
/**
 * ScraperAdapters — Domain adapters for SSA's universal ScraperEngine
 * -------------------------------------------------------------------
 * ROLE IN PIPELINE
 * imports (fetch/scrape) → intelligence (normalize/enrich via adapters) → automation (emit events) → (optional) hub export
 *
 * WHAT THIS FILE DOES
 * - Provides a set of extractor "adapters" that plug into ScraperEngine.registerExtractor().
 * - Each adapter:
 *    • test(url, doc, meta) → boolean   (should this adapter handle the page?)
 *    • extract({ url, html, doc, meta }) → enrichment object
 * - Adapters normalize JSON-LD (Recipe, HowTo, Product, VideoObject), harvest tables for seed/garden data,
 *   and prepare consistent enrichment payloads used by downstream ImportRouter/Normalizers.
 *
 * WHAT THIS FILE DOES *NOT* DO
 * - It does not mutate household state. It only enriches scrape results.
 * - It does not export to the Hub (no state change here).
 *
 * EXTENSION POINTS
 * - Add new adapters to ADAPTERS[] or call registerScraperAdapters({ register, adapters:[...] }).
 * - Use makeAdapter({id, domains, types, test, extract}) to quickly author new site/type handlers.
 *
 * EVENTS EMITTED
 * - scraper.adapter.registered
 *
 * DEFENSIVE DESIGN
 * - Helpers guard against malformed JSON-LD and missing nodes.
 */

import eventBus from '../eventBus.js';

const SOURCE = 'ScraperAdapters';
const nowISO = () => new Date().toISOString();
const emit = (type, data) => eventBus.emit({ type, ts: nowISO(), source: SOURCE, data });

/* -----------------------------------------------
 * Utilities (single-use, kept local for ergonomics)
 * --------------------------------------------- */

/** Safely read a nested prop, array or object. */
function get(obj, path, dflt = undefined) {
  try {
    return path.split('.').reduce((o, k) => (o && k in o ? o[k] : undefined), obj) ?? dflt;
  } catch {
    return dflt;
  }
}

/** Normalize a value into array (dropping falsy). */
function arr(v) {
  if (Array.isArray(v)) return v.filter(Boolean);
  if (v == null) return [];
  return [v].filter(Boolean);
}

/** Trim + collapse whitespace. */
function cleanText(v) {
  if (typeof v !== 'string') return '';
  return v.replace(/\s+/g, ' ').trim();
}

/** Parse ISO 8601 durations like PT30M, P1DT2H. Returns minutes (integer) where possible. */
function parseISODurationToMinutes(isoDur) {
  if (!isoDur || typeof isoDur !== 'string') return null;
  const m = isoDur.match(
    /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/
  );
  if (!m) return null;
  const days = parseInt(m[1] || '0', 10);
  const hours = parseInt(m[2] || '0', 10);
  const mins = parseInt(m[3] || '0', 10);
  // seconds ignored for SSA scheduling granularity
  return days * 24 * 60 + hours * 60 + mins;
}

/** Extract JSON-LD nodes of given @type (case-insensitive), flattening arrays/graphs. */
function pickJsonLdByType(jsonld, wantedTypes = []) {
  const types = arr(wantedTypes).map((t) => String(t).toLowerCase());
  const nodes = [];
  for (const node of arr(jsonld)) {
    const t = node && node['@type'];
    if (!t) continue;
    const nodeTypes = arr(t).map((x) => String(x).toLowerCase());
    if (nodeTypes.some((x) => types.includes(x))) {
      nodes.push(node);
    }
  }
  return nodes;
}

/** Map HowToStep or HowToSection to flat steps (text + optional time hints). */
function flattenHowToSteps(steps) {
  const out = [];
  for (const s of arr(steps)) {
    const type = (s && s['@type']) || '';
    if (/howtosection/i.test(type)) {
      out.push(...flattenHowToSteps(s.itemListElement || []));
    } else if (/howtostep/i.test(type) || typeof s === 'string') {
      const text = cleanText(get(s, 'text', typeof s === 'string' ? s : ''));
      if (!text) continue;
      out.push({
        text,
        // Optional minute hints
        time: {
          prep: parseISODurationToMinutes(get(s, 'prepTime')),
          perform: parseISODurationToMinutes(get(s, 'performTime')),
        },
      });
    }
  }
  return out;
}

/** Extract and normalize ingredients array from Recipe JSON-LD. */
function parseRecipeIngredients(node) {
  const list = arr(node.recipeIngredient || node.ingredients || node.supply);
  // Fall back: Some sites put ingredients in HowTo "supply" items as name fields
  const supplies = arr(get(node, 'supply'))
    .map((s) => cleanText(get(s, 'name')))
    .filter(Boolean);
  const merged = [...list.map(cleanText), ...supplies].filter(Boolean);
  return merged;
}

/** Extract Nutrition info (macro + common micro) when present. */
function parseNutrition(node) {
  const n = get(node, 'nutrition') || {};
  const map = (k) => (n[k] ? cleanText(String(n[k])) : undefined);
  const result = {
    calories: map('calories'),
    fatContent: map('fatContent'),
    carbohydrateContent: map('carbohydrateContent'),
    proteinContent: map('proteinContent'),
    fiberContent: map('fiberContent'),
    sugarContent: map('sugarContent'),
    sodiumContent: map('sodiumContent'),
    cholesterolContent: map('cholesterolContent'),
    // common micros if present (non-standard across sites):
    vitaminCContent: map('vitaminCContent'),
    calciumContent: map('calciumContent'),
    ironContent: map('ironContent'),
    potassiumContent: map('potassiumContent'),
  };
  // prune empty
  Object.keys(result).forEach((k) => result[k] == null && delete result[k]);
  return Object.keys(result).length ? result : undefined;
}

/** Heuristic table reader for seed spacing / germination tables. */
function parseSeedTablesForGardenHints(tables) {
  const out = [];
  for (const t of arr(tables)) {
    const hdr = (t.header || []).map((h) => (h || '').toLowerCase());
    const rowObjs = arr(t.rows);
    const looksLikeSeedTable =
      hdr.some((h) => /seed|spacing|depth|germination|days|zone|sun/.test(h));
    if (!looksLikeSeedTable) continue;

    for (const row of rowObjs) {
      const record = {};
      for (const [k, v] of Object.entries(row)) {
        const lk = k.toLowerCase();
        if (/variety|cultivar|crop|plant|name/.test(lk)) record.crop = cleanText(v);
        if (/seed.*(spacing|apart)|spacing/.test(lk)) record.spacing = cleanText(v);
        if (/depth/.test(lk)) record.depth = cleanText(v);
        if (/germin/.test(lk)) record.germination = cleanText(v);
        if (/days.*(maturity|harvest)/.test(lk)) record.daysToMaturity = cleanText(v);
        if (/zone/.test(lk)) record.zone = cleanText(v);
        if (/sun|light/.test(lk)) record.sun = cleanText(v);
        if (/water/.test(lk)) record.water = cleanText(v);
        if (/row/.test(lk)) record.row = cleanText(v);
      }
      // keep only meaningful rows
      if (Object.keys(record).length > 0) out.push(record);
    }
  }
  return out;
}

/** Helper to create a simple adapter with domain + jsonld type filters. */
function makeAdapter({ id, domains = [], jsonldTypes = [], test, extract }) {
  const domainMatch = (url) => {
    if (!domains.length) return true;
    try {
      const host = new URL(url).hostname.toLowerCase();
      return domains.some((d) => host === d || host.endsWith(`.${d}`));
    } catch {
      return false;
    }
  };

  const typesMatch = (jsonld) => {
    if (!jsonldTypes.length) return true;
    return pickJsonLdByType(jsonld, jsonldTypes).length > 0;
  };

  return {
    id,
    test: (url, doc, meta) => {
      try {
        if (!domainMatch(url)) return false;
        if (!typesMatch(meta?.jsonld || get(meta, 'jsonld'))) return false;
        if (typeof test === 'function') return !!test(url, doc, meta);
        return true;
      } catch {
        return false;
      }
    },
    extract: async (ctx) => {
      try {
        if (typeof extract === 'function') return await extract(ctx);
        return {};
      } catch {
        return {};
      }
    },
  };
}

/* -----------------------------------------------
 * Built-in Adapters
 * --------------------------------------------- */

/**
 * Generic Recipe (JSON-LD) — works across many cooking sites.
 */
const GenericRecipeJSONLD = makeAdapter({
  id: 'generic.recipe.jsonld',
  jsonldTypes: ['Recipe'],
  extract: async ({ meta }) => {
    const nodes = pickJsonLdByType(meta?.jsonld || get(meta, 'jsonld'), ['Recipe']);
    if (!nodes.length) return {};
    const r = nodes[0]; // prefer first recipe node

    const name = cleanText(r.name);
    const by = cleanText(get(r, 'author.name', get(r, 'author[0].name', '')));
    const yieldText = cleanText(r.recipeYield || '');
    const category = cleanText(r.recipeCategory || '');
    const cuisine = cleanText(r.recipeCuisine || '');

    const time = {
      totalMinutes: parseISODurationToMinutes(r.totalTime),
      prepMinutes: parseISODurationToMinutes(r.prepTime),
      cookMinutes: parseISODurationToMinutes(r.cookTime),
    };

    const ingredients = parseRecipeIngredients(r);
    const instructions = flattenHowToSteps(r.recipeInstructions || []);
    const nutrition = parseNutrition(r);

    return {
      kind: 'recipe',
      recipe: {
        name,
        author: by || undefined,
        yield: yieldText || undefined,
        category: category || undefined,
        cuisine: cuisine || undefined,
        time,
        ingredients,
        steps: instructions,
        nutrition,
        media: {
          image: cleanText(get(r, 'image.url', get(r, 'image[0]'))),
          video: cleanText(get(r, 'video.contentUrl')),
        },
      },
    };
  },
});

/**
 * Generic HowTo (JSON-LD) — maps to cleaning/procedures.
 */
const GenericHowToJSONLD = makeAdapter({
  id: 'generic.howto.jsonld',
  jsonldTypes: ['HowTo'],
  extract: async ({ meta }) => {
    const nodes = pickJsonLdByType(meta?.jsonld || get(meta, 'jsonld'), ['HowTo']);
    if (!nodes.length) return {};
    const h = nodes[0];

    const name = cleanText(h.name);
    const supplies = arr(get(h, 'supply'))
      .map((s) => cleanText(get(s, 'name') || s))
      .filter(Boolean);
    const tools = arr(get(h, 'tool'))
      .map((t) => cleanText(get(t, 'name') || t))
      .filter(Boolean);
    const steps = flattenHowToSteps(h.step || h.steps || h.itemListElement || []);

    const time = {
      totalMinutes: parseISODurationToMinutes(h.totalTime),
      prepMinutes: parseISODurationToMinutes(h.prepTime),
      performMinutes: parseISODurationToMinutes(h.performTime),
    };

    return {
      kind: 'procedure',
      procedure: {
        domainHint: 'cleaning', // downstream may reclassify based on content
        name,
        supplies,
        tools,
        steps,
        time,
        safety: arr(h.safetyConsideration || [])
          .map((s) => cleanText(get(s, 'name') || s))
          .filter(Boolean),
      },
    };
  },
});

/**
 * Allrecipes — more opinionated extraction when available.
 */
const Allrecipes = makeAdapter({
  id: 'allrecipes.com',
  domains: ['allrecipes.com'],
  jsonldTypes: ['Recipe'],
  extract: async ({ meta }) => {
    const nodes = pickJsonLdByType(meta?.jsonld || get(meta, 'jsonld'), ['Recipe']);
    if (!nodes.length) return {};
    const r = nodes[0];

    // Allrecipes often has structured rating + category tags
    const rating = {
      ratingValue: Number(get(r, 'aggregateRating.ratingValue')) || undefined,
      ratingCount: Number(get(r, 'aggregateRating.ratingCount')) || undefined,
    };

    return {
      kind: 'recipe',
      recipe: {
        name: cleanText(r.name),
        author: cleanText(get(r, 'author.name')),
        yield: cleanText(r.recipeYield),
        category: cleanText(arr(r.recipeCategory).join(', ')),
        cuisine: cleanText(arr(r.recipeCuisine).join(', ')),
        time: {
          totalMinutes: parseISODurationToMinutes(r.totalTime),
          prepMinutes: parseISODurationToMinutes(r.prepTime),
          cookMinutes: parseISODurationToMinutes(r.cookTime),
        },
        ingredients: parseRecipeIngredients(r),
        steps: flattenHowToSteps(r.recipeInstructions || []),
        nutrition: parseNutrition(r),
        rating,
        media: {
          image: cleanText(get(r, 'image.url', get(r, 'image[0]'))),
          video: cleanText(get(r, 'video.contentUrl')),
        },
      },
    };
  },
});

/**
 * YouTube — normalize to a Video enrichment (useful for video/how-to).
 */
const YouTube = makeAdapter({
  id: 'youtube.com',
  domains: ['youtube.com', 'youtu.be', 'm.youtube.com'],
  jsonldTypes: ['VideoObject'],
  extract: async ({ url, meta }) => {
    const nodes = pickJsonLdByType(meta?.jsonld || get(meta, 'jsonld'), ['VideoObject']);
    const v = nodes[0] || {};
    return {
      kind: 'video',
      video: {
        title: cleanText(v.name || get(meta, 'og.title') || get(meta, 'twitter.title')),
        description: cleanText(v.description || get(meta, 'og.description') || get(meta, 'twitter.description')),
        author: cleanText(get(v, 'author.name') || get(v, 'publisher.name')),
        embedUrl: cleanText(v.embedUrl || v.contentUrl || url),
        thumbnail: cleanText(get(v, 'thumbnailUrl[0]', v.thumbnailUrl)),
        durationMinutes: parseISODurationToMinutes(v.duration),
      },
    };
  },
});

/**
 * Pinterest — treat as inspiration board with outbound links and image focus.
 */
const Pinterest = makeAdapter({
  id: 'pinterest.com',
  domains: ['pinterest.com', 'pin.it'],
  extract: async ({ meta, url }) => {
    return {
      kind: 'collection',
      collection: {
        title: cleanText(get(meta, 'og.title') || get(meta, 'twitter.title')),
        description: cleanText(get(meta, 'og.description') || get(meta, 'twitter.description')),
        coverImage: cleanText(get(meta, 'og.image') || get(meta, 'twitter.image')),
        sourceUrl: url,
      },
    };
  },
});

/**
 * Seed vendors or garden knowledge pages — read seed tables for garden hints.
 * Matches common domains loosely; feel free to expand.
 */
const SeedVendor = makeAdapter({
  id: 'garden.seed.vendor',
  test: (url, _doc, meta) => {
    const host = (() => {
      try {
        return new URL(url).hostname.toLowerCase();
      } catch {
        return '';
      }
    })();
    // Heuristic: domains that often include seed spacing tables
    const seedsHosts = [
      'seedsavers.org',
      'rareseeds.com',
      'johnnyseeds.com',
      'burpee.com',
      'territorialseed.com',
      'highmowingseeds.com',
      'edenbrothers.com',
    ];
    const looksGarden =
      /seed|germination|planting|garden|cultivar|heirloom|zone|spacing|row/i.test(
        JSON.stringify(meta || {})
      );
    return seedsHosts.some((d) => host === d || host.endsWith(`.${d}`)) || looksGarden;
  },
  extract: async ({ meta, html, doc }) => {
    // Prefer tables from ScraperEngine (placed into final payload by engine).
    // When running as a plugin, we don't have the computed tables here; but some engines pass doc.
    // We'll fallback to extracting simple key-value pairs from definition lists if present.
    const tables = [];
    // Lightweight in-adapter table sweep (mirrors engine, but constrained):
    try {
      const tNodes = doc ? [...doc.querySelectorAll('table')] : [];
      for (const t of tNodes) {
        const headers = [];
        const headerRow = t.querySelector('thead tr') || t.querySelector('tr');
        if (headerRow) {
          [...headerRow.querySelectorAll('th,td')].forEach((c, idx) => {
            headers[idx] = cleanText(c.textContent) || `col_${idx + 1}`;
          });
        }
        const bodyRows =
          t.querySelectorAll('tbody tr').length > 0
            ? [...t.querySelectorAll('tbody tr')]
            : [...t.querySelectorAll('tr')].slice(1);
        const rows = bodyRows.map((tr) => {
          const obj = {};
          [...tr.querySelectorAll('td,th')].forEach((cell, idx) => {
            const key = headers[idx] || `col_${idx + 1}`;
            obj[key] = cleanText(cell.textContent);
          });
          return obj;
        });
        if (rows.length) tables.push({ header: headers, rows });
      }
    } catch {
      // ignore DOM issues
    }

    const hints = parseSeedTablesForGardenHints(tables);
    return {
      kind: 'garden',
      garden: {
        hints,
        // Basic meta relay for downstream (crop name guesses via title)
        cropGuess: cleanText(get(meta, 'title')),
      },
    };
  },
});

/**
 * Store Product — normalize Product/Offer info (maps toward storehouse/inventory).
 */
const StoreProduct = makeAdapter({
  id: 'generic.product.jsonld',
  jsonldTypes: ['Product', 'Offer', 'AggregateOffer'],
  extract: async ({ meta }) => {
    const products = pickJsonLdByType(meta?.jsonld || get(meta, 'jsonld'), ['Product']);
    const offers = pickJsonLdByType(meta?.jsonld || get(meta, 'jsonld'), ['Offer', 'AggregateOffer']);
    const p = products[0] || {};
    const o = offers[0] || {};

    const price = cleanText(get(o, 'price') || get(p, 'offers.price'));
    const priceCurrency = cleanText(get(o, 'priceCurrency') || get(p, 'offers.priceCurrency'));
    const sku = cleanText(p.sku || get(p, 'gtin13') || get(p, 'gtin12') || get(p, 'mpn'));

    return {
      kind: 'storehouse',
      product: {
        name: cleanText(p.name || get(meta, 'og.title')),
        description: cleanText(p.description || get(meta, 'og.description')),
        sku: sku || undefined,
        brand: cleanText(get(p, 'brand.name', p.brand)),
        image: cleanText(get(p, 'image[0]', get(p, 'image')) || get(meta, 'og.image')),
        price: price || undefined,
        priceCurrency: priceCurrency || undefined,
        availability: cleanText(get(p, 'offers.availability') || get(o, 'availability')),
        url: cleanText(get(p, 'offers.url') || get(o, 'url') || get(meta, 'og.url')),
      },
    };
  },
});

/* -----------------------------------------------
 * Registration API
 * --------------------------------------------- */

const ADAPTERS = [
  GenericRecipeJSONLD,
  GenericHowToJSONLD,
  Allrecipes,
  YouTube,
  Pinterest,
  SeedVendor,
  StoreProduct,
];

/**
 * Register adapters with a given register() function.
 * Typical usage:
 *    import ScraperEngine from './ScraperEngine';
 *    registerScraperAdapters({ register: ScraperEngine.registerExtractor });
 */
export function registerScraperAdapters({ register, adapters = ADAPTERS } = {}) {
  if (typeof register !== 'function') {
    throw new Error('registerScraperAdapters requires a { register } function.');
  }
  const ids = [];
  for (const a of adapters) {
    try {
      register(a);
      ids.push(a.id);
    } catch {
      // skip bad adapter to avoid breaking entire fleet
    }
  }
  if (ids.length) emit('scraper.adapter.registered', { adapters: ids });
  return ids;
}

/**
 * Convenience auto-registration:
 * Attempts to import ScraperEngine dynamically and register adapters.
 * Safe no-op on failure (handles circular import or not yet available).
 */
export async function autoRegisterAdapters() {
  try {
    const mod = await import('./ScraperEngine.js');
    const engine = mod.default || mod;
    if (engine && typeof engine.registerExtractor === 'function') {
      return registerScraperAdapters({ register: engine.registerExtractor });
    }
  } catch {
    // ignore (engine not ready or circular import)
  }
  return [];
}

/* -----------------------------------------------
 * Exports for custom extension / testing
 * --------------------------------------------- */

export const BuiltInAdapters = Object.freeze({
  GenericRecipeJSONLD,
  GenericHowToJSONLD,
  Allrecipes,
  YouTube,
  Pinterest,
  SeedVendor,
  StoreProduct,
});

export default {
  registerScraperAdapters,
  autoRegisterAdapters,
  BuiltInAdapters,
  makeAdapter, // for authoring custom adapters in-app
};

/**
 * DEV NOTES / FUTURE:
 * - Add domain-specialized adapters for: SeriousEats, NYT Cooking, Food Network, Walmart/Kroger product pages,
 *   Home Depot/Lowe’s store SKU pages, USDA/Extension PDFs (with a PDF adapter in ScraperEngine).
 * - Add preservation adapters (fermentation, canning) that infer task steps and safety checks from HowTo guides.
 * - Add animal/butchery adapters to extract cut sheets and yield tables from extension websites.
 * - Add video chapter parsing for YouTube/Vimeo (ytInitialPlayerResponse → chapter markers → steps).
 * - Consider confidence scoring per adapter to aid ImportRouter in case of multiple matches.
 */
