/* eslint-disable no-console */
// C:\Users\larho\suka-smart-assistant\src\services\knowledgeHelper\ContextMatcher.js
/**
 * SSA • Knowledge Helper • ContextMatcher
 * -----------------------------------------------------------------------------
 * Browser-safe, deterministic context matching (no network, no Node imports).
 *
 * Purpose:
 *  - Given a user query (question, goal, error, task), find the best matching
 *    Knowledge items (skills, methods, components, SOPs, KB notes, docs).
 *  - Provide explainable scoring and stable results.
 *  - Support incremental index updates, lightweight caching, and filters.
 *
 * Matching strategy (hybrid, deterministic):
 *  - Normalization + tokenization + lightweight stemming
 *  - BM25-style scoring (TF/IDF with doc length normalization)
 *  - Field boosts (title > tags/keywords > summary > body/steps)
 *  - Phrase / ordered term bonus
 *  - Tag/domain/intent boosts (optional)
 *  - Penalties for weak/short queries and low-overlap matches
 *
 * This file intentionally avoids Dexie/eventBus imports to keep it reusable.
 * Callers can cache results in Dexie and emit events upstream as needed.
 *
 * -----------------------------------------------------------------------------
 * Item shape (recommended, but flexible):
 * {
 *   id: string,
 *   type?: "skill"|"method"|"component"|"kb"|"doc"|"recipe"|string,
 *   domain?: "cooking"|"cleaning"|...|string,
 *   title?: string,
 *   summary?: string,
 *   body?: string,
 *   steps?: string[]|string,
 *   tags?: string[],
 *   keywords?: string[],
 *   source?: string,
 *   url?: string,
 *   updatedAt?: number|string,
 *   createdAt?: number|string,
 *   meta?: object
 * }
 */

const DEFAULTS = Object.freeze({
  // core
  minQueryChars: 3,
  minTokens: 1,
  maxQueryTokens: 40,
  limit: 12,
  minScore: 0.15, // post-normalized to 0..1-ish
  includeDebug: false,
  includeHighlights: true,

  // indexing
  enableCache: true,
  cacheMax: 200, // query-result cache
  cacheTtlMs: 2 * 60 * 1000,

  // BM25-like
  bm25K1: 1.2,
  bm25B: 0.75,

  // field boosts (relative)
  boosts: {
    title: 4.0,
    tags: 2.2,
    keywords: 2.0,
    summary: 1.6,
    body: 1.0,
    steps: 1.2,
    domain: 0.6,
    type: 0.4,
    source: 0.25,
  },

  // phrase/order bonus
  phraseBonus: 0.12,
  orderedBonus: 0.06,

  // tag & filter behavior
  tagMatchBonus: 0.08, // additive bonus (normalized scale)
  domainMatchBonus: 0.1,
  typeMatchBonus: 0.05,

  // safety/perf
  maxItemsToScore: 5000, // protect UI thread; caller can split by domain
  maxTextCharsPerField: 6000, // clamp field strings
  maxHighlightsPerItem: 12,
});

const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "been",
  "but",
  "by",
  "can",
  "could",
  "did",
  "do",
  "does",
  "doing",
  "down",
  "for",
  "from",
  "had",
  "has",
  "have",
  "having",
  "he",
  "her",
  "here",
  "hers",
  "him",
  "his",
  "how",
  "i",
  "if",
  "in",
  "into",
  "is",
  "it",
  "its",
  "just",
  "like",
  "may",
  "me",
  "might",
  "more",
  "most",
  "my",
  "no",
  "not",
  "of",
  "on",
  "one",
  "or",
  "our",
  "out",
  "over",
  "really",
  "said",
  "same",
  "she",
  "should",
  "so",
  "some",
  "such",
  "than",
  "that",
  "the",
  "their",
  "them",
  "then",
  "there",
  "these",
  "they",
  "this",
  "those",
  "to",
  "too",
  "up",
  "us",
  "was",
  "we",
  "were",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "will",
  "with",
  "would",
  "you",
  "your",
]);

/* -----------------------------------------------------------------------------
 * Utilities
 * -------------------------------------------------------------------------- */

function clampString(s, maxChars) {
  if (!s) return "";
  const str = String(s);
  if (str.length <= maxChars) return str;
  return str.slice(0, maxChars);
}

function toLowerSafe(s) {
  return (s == null ? "" : String(s)).toLowerCase();
}

function stripDiacritics(s) {
  // Browser-safe normalization (supported by modern engines)
  try {
    return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  } catch {
    return s; // fallback
  }
}

function normalizeText(s) {
  const t = stripDiacritics(toLowerSafe(s));
  // keep letters/digits/apostrophes; turn others into spaces
  return t
    .replace(/[^a-z0-9'’]+/g, " ")
    .replace(/[’]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function simpleStem(token) {
  // Lightweight, deterministic, avoids heavy porter stemmer.
  // Good enough for household KB matching.
  let t = token;
  if (t.length <= 3) return t;

  // common suffix stripping
  const rules = [
    ["ing", 4],
    ["edly", 5],
    ["edly", 5],
    ["edly", 5],
    ["edly", 5],
    ["edly", 5],
    ["edly", 5],
    ["edly", 5],
    ["edly", 5],
  ];
  // (above intentionally redundant? no—remove; keep minimal)
  // Let's do a simpler set:
  const suffixes = [
    ["ingly", 6],
    ["edly", 5],
    ["ingly", 6],
    ["ingly", 6],
    ["ingly", 6],
    ["ingly", 6],
    ["ment", 5],
    ["ments", 6],
    ["tion", 4],
    ["tions", 5],
    ["ation", 5],
    ["ations", 6],
    ["ness", 5],
    ["less", 5],
    ["able", 5],
    ["ible", 5],
    ["ings", 5],
    ["ing", 4],
    ["ers", 4],
    ["er", 3],
    ["ies", 4],
    ["ied", 4],
    ["ed", 3],
    ["s", 3],
  ];

  for (let i = 0; i < suffixes.length; i++) {
    const [suf, minLen] = suffixes[i];
    if (t.endsWith(suf) && t.length >= minLen) {
      const cut = t.slice(0, -suf.length);
      if (cut.length >= 3) {
        // y<->i normalization
        if (suf === "ies" && cut.endsWith("i")) return cut.slice(0, -1) + "y";
        if (suf === "ied" && cut.endsWith("i")) return cut.slice(0, -1) + "y";
        return cut;
      }
    }
  }
  return t;
}

function tokenize(text, { maxTokens = DEFAULTS.maxQueryTokens } = {}) {
  const norm = normalizeText(text);
  if (!norm) return [];
  const raw = norm.split(" ");
  const out = [];
  for (let i = 0; i < raw.length; i++) {
    const tok = raw[i];
    if (!tok) continue;
    if (STOPWORDS.has(tok)) continue;
    const stem = simpleStem(tok);
    if (!stem) continue;
    out.push(stem);
    if (out.length >= maxTokens) break;
  }
  return out;
}

function uniq(arr) {
  const set = new Set();
  const out = [];
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    if (!set.has(v)) {
      set.add(v);
      out.push(v);
    }
  }
  return out;
}

function nowMs() {
  return Date.now();
}

function safeNumberTime(v) {
  if (v == null) return null;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? t : null;
}

function stableHash32(str) {
  // FNV-1a 32-bit
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)) >>> 0;
  }
  return h >>> 0;
}

class LruCache {
  constructor(max = 200, ttlMs = 120000) {
    this.max = Math.max(10, max | 0);
    this.ttlMs = Math.max(1000, ttlMs | 0);
    this.map = new Map(); // key -> { value, exp }
  }
  get(key) {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (hit.exp <= nowMs()) {
      this.map.delete(key);
      return undefined;
    }
    // refresh LRU
    this.map.delete(key);
    this.map.set(key, hit);
    return hit.value;
  }
  set(key, value) {
    const exp = nowMs() + this.ttlMs;
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { value, exp });
    while (this.map.size > this.max) {
      const firstKey = this.map.keys().next().value;
      this.map.delete(firstKey);
    }
  }
  clear() {
    this.map.clear();
  }
}

/* -----------------------------------------------------------------------------
 * Index structures
 * -------------------------------------------------------------------------- */

function buildFieldText(item, field, maxChars) {
  if (!item) return "";
  if (field === "steps") {
    const s = item.steps;
    if (Array.isArray(s)) return clampString(s.join("\n"), maxChars);
    return clampString(s, maxChars);
  }
  if (field === "tags" || field === "keywords") {
    const a = item[field];
    if (Array.isArray(a)) return clampString(a.join(" "), maxChars);
    return clampString(a, maxChars);
  }
  return clampString(item[field], maxChars);
}

function computeTf(tokens) {
  const tf = new Map();
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    tf.set(t, (tf.get(t) || 0) + 1);
  }
  return tf;
}

function mergeDf(df, tf) {
  // df token -> doc freq
  tf.forEach((_count, token) => {
    df.set(token, (df.get(token) || 0) + 1);
  });
}

function idfFromDf(df, N) {
  const idf = new Map();
  const n = Math.max(1, N);
  df.forEach((d, token) => {
    // classic BM25 IDF with smoothing
    const num = n - d + 0.5;
    const den = d + 0.5;
    const val = Math.log(1 + num / den);
    idf.set(token, val);
  });
  return idf;
}

function bm25Score(tf, docLen, avgDocLen, idf, qTokens, k1, b) {
  if (!qTokens.length) return 0;
  const dl = Math.max(1, docLen);
  const avdl = Math.max(1, avgDocLen);
  const denomNorm = k1 * (1 - b + (b * dl) / avdl);
  let score = 0;

  // Use unique query tokens to avoid over-weighting repeated words in query.
  const qU = uniq(qTokens);
  for (let i = 0; i < qU.length; i++) {
    const t = qU[i];
    const f = tf.get(t) || 0;
    if (!f) continue;
    const w = idf.get(t) || 0;
    const numer = f * (k1 + 1);
    const denom = f + denomNorm;
    score += w * (numer / denom);
  }
  return score;
}

function orderBonus(normDocText, normQueryText, orderedTokens) {
  // if query tokens appear in order in the doc text, small bonus
  // (cheap check: subsequence scan over tokens of doc)
  if (!orderedTokens.length) return 0;
  const docTokens = tokenize(normDocText, { maxTokens: 300 });
  if (!docTokens.length) return 0;
  let j = 0;
  for (let i = 0; i < docTokens.length && j < orderedTokens.length; i++) {
    if (docTokens[i] === orderedTokens[j]) j++;
  }
  return j === orderedTokens.length ? 1 : 0;
}

function phraseHit(normDocText, normQueryText) {
  if (!normQueryText || normQueryText.length < 6) return 0;
  // Only test phrase if query has at least 2 non-stopword tokens
  const qTokens = tokenize(normQueryText, { maxTokens: 20 });
  if (qTokens.length < 2) return 0;
  // Use normalized (stopword-removed) "phrase" approximation:
  // Join tokens with spaces and look for it in a simplified doc token string.
  const qPhrase = qTokens.join(" ");
  const dTokens = tokenize(normDocText, { maxTokens: 400 });
  if (dTokens.length < 2) return 0;
  const dPhrase = dTokens.join(" ");
  return dPhrase.includes(qPhrase) ? 1 : 0;
}

function buildHighlights(item, qTokens, cfg) {
  const max = cfg.maxHighlightsPerItem || DEFAULTS.maxHighlightsPerItem;
  const fields = ["title", "tags", "keywords", "summary", "steps", "body"];
  const hits = [];
  const qSet = new Set(qTokens);

  for (let f = 0; f < fields.length; f++) {
    const field = fields[f];
    const text = normalizeText(
      buildFieldText(item, field, cfg.maxTextCharsPerField)
    );
    if (!text) continue;
    const toks = tokenize(text, { maxTokens: 200 });
    let count = 0;
    for (let i = 0; i < toks.length; i++) {
      if (qSet.has(toks[i])) count++;
    }
    if (count > 0) {
      hits.push({ field, hitCount: count });
    }
  }

  hits.sort((a, b) => b.hitCount - a.hitCount);
  return hits.slice(0, max);
}

function normalizeScore(score, maxScore) {
  if (maxScore <= 0) return 0;
  // Smooth normalization to keep interpretability.
  const x = score / maxScore;
  // squash slightly (avoid 0.99 spam)
  return Math.max(0, Math.min(1, Math.pow(x, 0.72)));
}

/* -----------------------------------------------------------------------------
 * ContextMatcher
 * -------------------------------------------------------------------------- */

export class ContextMatcher {
  constructor(options = {}) {
    this.cfg = {
      ...DEFAULTS,
      ...options,
      boosts: { ...DEFAULTS.boosts, ...(options.boosts || {}) },
    };

    this._items = []; // raw items array
    this._doc = new Map(); // id -> prepared doc object
    this._df = new Map(); // token -> doc freq
    this._idf = new Map(); // token -> idf
    this._avgLen = 1;

    this._cache = this.cfg.enableCache
      ? new LruCache(this.cfg.cacheMax, this.cfg.cacheTtlMs)
      : null;

    this._fingerprint = 0;
  }

  get size() {
    return this._items.length;
  }

  get fingerprint() {
    // changes whenever items/index changes, useful for caller cache keys
    return this._fingerprint;
  }

  clearCache() {
    if (this._cache) this._cache.clear();
  }

  /**
   * Replace all items and rebuild index.
   */
  setItems(items = []) {
    this._items = Array.isArray(items) ? items.slice() : [];
    this._rebuildIndex();
    this.clearCache();
    return this;
  }

  /**
   * Incrementally add items and rebuild index (safe + simple).
   * For large catalogs, prefer batching then setItems() once.
   */
  addItems(items = []) {
    if (!Array.isArray(items) || items.length === 0) return this;
    this._items = this._items.concat(items);
    this._rebuildIndex();
    this.clearCache();
    return this;
  }

  /**
   * Remove items by id and rebuild.
   */
  removeByIds(ids = []) {
    const remove = new Set(Array.isArray(ids) ? ids : []);
    if (!remove.size) return this;
    this._items = this._items.filter((it) => it && !remove.has(it.id));
    this._rebuildIndex();
    this.clearCache();
    return this;
  }

  /**
   * Main match call.
   * @param {object} input
   * @param {string} input.query - user text
   * @param {string=} input.domain - preferred domain
   * @param {string[]=} input.tags - preferred tags
   * @param {string|string[]=} input.type - preferred type(s)
   * @param {object=} input.filters - { domainAllow, domainDeny, tagAllow, tagDeny, typeAllow, typeDeny }
   * @param {object=} input.options - overrides (limit, minScore, includeDebug...)
   */
  match(input = {}) {
    const query = String(input.query || "");
    const opts = { ...(input.options || {}) };
    const cfg = {
      ...this.cfg,
      ...opts,
      boosts: { ...this.cfg.boosts, ...(opts.boosts || {}) },
    };

    const trimmed = query.trim();
    if (trimmed.length < cfg.minQueryChars) {
      return this._emptyResult(trimmed, cfg, "query_too_short");
    }

    const qTokens = tokenize(trimmed, { maxTokens: cfg.maxQueryTokens });
    if (qTokens.length < cfg.minTokens) {
      return this._emptyResult(trimmed, cfg, "no_tokens");
    }

    const prefDomain = input.domain ? String(input.domain) : null;
    const prefTags = Array.isArray(input.tags) ? input.tags.map(String) : [];
    const prefTypes = Array.isArray(input.type)
      ? input.type.map(String)
      : input.type
      ? [String(input.type)]
      : [];

    const filters = input.filters || {};

    // cache key: query + preferences + index fingerprint
    const cacheKey = this._cache
      ? this._makeCacheKey(
          trimmed,
          qTokens,
          prefDomain,
          prefTags,
          prefTypes,
          filters,
          cfg
        )
      : null;

    if (this._cache && cacheKey) {
      const cached = this._cache.get(cacheKey);
      if (cached) return cached;
    }

    const preparedQuery = {
      raw: trimmed,
      norm: normalizeText(trimmed),
      tokens: qTokens,
      tokenSet: new Set(qTokens),
    };

    // candidate iteration
    const itemsToScore = Math.min(this._items.length, cfg.maxItemsToScore);
    const scored = [];
    let maxRawScore = 0;

    for (let i = 0; i < itemsToScore; i++) {
      const item = this._items[i];
      if (!item || !item.id) continue;

      // filter check first (cheap)
      if (!this._passesFilters(item, filters)) continue;

      const doc = this._doc.get(item.id);
      if (!doc) continue;

      const s = this._scoreDoc(
        doc,
        item,
        preparedQuery,
        prefDomain,
        prefTags,
        prefTypes,
        cfg
      );
      if (s.rawScore <= 0) continue;

      if (s.rawScore > maxRawScore) maxRawScore = s.rawScore;
      scored.push(s);
    }

    // normalize + rank
    for (let i = 0; i < scored.length; i++) {
      scored[i].score = normalizeScore(scored[i].rawScore, maxRawScore);
    }

    scored.sort((a, b) => b.score - a.score);

    const out = [];
    for (let i = 0; i < scored.length; i++) {
      const s = scored[i];
      if (s.score < cfg.minScore) break;
      out.push(this._formatHit(s, cfg));
      if (out.length >= cfg.limit) break;
    }

    const result = {
      ok: true,
      query: trimmed,
      tokens: qTokens,
      fingerprint: this._fingerprint,
      totalItems: this._items.length,
      scoredItems: scored.length,
      results: out,
      debug: cfg.includeDebug
        ? {
            maxRawScore,
            usedItems: itemsToScore,
            preferences: {
              domain: prefDomain,
              tags: prefTags,
              types: prefTypes,
            },
          }
        : undefined,
    };

    if (this._cache && cacheKey) this._cache.set(cacheKey, result);
    return result;
  }

  /**
   * Convenience: match multiple queries (shared cache/index).
   */
  matchMany(queries = [], common = {}) {
    const list = Array.isArray(queries) ? queries : [];
    const out = [];
    for (let i = 0; i < list.length; i++) {
      out.push(this.match({ ...common, query: list[i] }));
    }
    return out;
  }

  /* -------------------------------------------------------------------------
   * Internals
   * ---------------------------------------------------------------------- */

  _emptyResult(query, cfg, reason) {
    return {
      ok: true,
      query,
      tokens: [],
      fingerprint: this._fingerprint,
      totalItems: this._items.length,
      scoredItems: 0,
      results: [],
      debug: cfg.includeDebug ? { reason } : undefined,
    };
  }

  _makeCacheKey(rawQuery, qTokens, domain, tags, types, filters, cfg) {
    const base = [
      this._fingerprint,
      normalizeText(rawQuery),
      qTokens.join(","),
      domain || "",
      (tags || []).slice().sort().join(","),
      (types || []).slice().sort().join(","),
      JSON.stringify(filters || {}),
      String(cfg.limit),
      String(cfg.minScore),
    ].join("|");
    return String(stableHash32(base));
  }

  _passesFilters(item, filters) {
    if (!filters) return true;

    const dom = item.domain ? String(item.domain) : "";
    const typ = item.type ? String(item.type) : "";
    const tags = Array.isArray(item.tags) ? item.tags.map(String) : [];

    const allowDomain = filters.domainAllow
      ? new Set(filters.domainAllow.map(String))
      : null;
    const denyDomain = filters.domainDeny
      ? new Set(filters.domainDeny.map(String))
      : null;
    const allowType = filters.typeAllow
      ? new Set(filters.typeAllow.map(String))
      : null;
    const denyType = filters.typeDeny
      ? new Set(filters.typeDeny.map(String))
      : null;
    const allowTag = filters.tagAllow
      ? new Set(filters.tagAllow.map(String))
      : null;
    const denyTag = filters.tagDeny
      ? new Set(filters.tagDeny.map(String))
      : null;

    if (allowDomain && allowDomain.size && !allowDomain.has(dom)) return false;
    if (denyDomain && denyDomain.size && denyDomain.has(dom)) return false;

    if (allowType && allowType.size && !allowType.has(typ)) return false;
    if (denyType && denyType.size && denyType.has(typ)) return false;

    if (denyTag && denyTag.size) {
      for (let i = 0; i < tags.length; i++) {
        if (denyTag.has(tags[i])) return false;
      }
    }
    if (allowTag && allowTag.size) {
      let ok = false;
      for (let i = 0; i < tags.length; i++) {
        if (allowTag.has(tags[i])) {
          ok = true;
          break;
        }
      }
      if (!ok) return false;
    }

    return true;
  }

  _formatHit(scoredDoc, cfg) {
    const { item, score, rawScore, contributions, highlights, matchMeta } =
      scoredDoc;

    const base = {
      id: item.id,
      type: item.type || null,
      domain: item.domain || null,
      title: item.title || item.name || "(untitled)",
      summary: item.summary || null,
      tags: Array.isArray(item.tags) ? item.tags : [],
      source: item.source || null,
      url: item.url || null,
      score,
      matchMeta,
    };

    if (cfg.includeHighlights) base.highlights = highlights;
    if (cfg.includeDebug) {
      base.debug = {
        rawScore,
        contributions,
        updatedAt: item.updatedAt || null,
      };
    }

    return base;
  }

  _scoreDoc(doc, item, q, prefDomain, prefTags, prefTypes, cfg) {
    const boosts = cfg.boosts;

    // Base score: weighted sum of BM25 per field
    let raw = 0;
    const contributions = {};

    const fields = [
      "title",
      "tags",
      "keywords",
      "summary",
      "steps",
      "body",
      "domain",
      "type",
      "source",
    ];
    for (let i = 0; i < fields.length; i++) {
      const f = fields[i];
      const comp = doc.fields[f];
      if (!comp) continue;
      const b = boosts[f] || 1;

      const s = bm25Score(
        comp.tf,
        comp.len,
        this._avgLen,
        this._idf,
        q.tokens,
        cfg.bm25K1,
        cfg.bm25B
      );

      if (s > 0) {
        const w = s * b;
        raw += w;
        if (cfg.includeDebug) contributions[f] = w;
      }
    }

    if (raw <= 0) {
      return {
        item,
        score: 0,
        rawScore: 0,
        contributions: cfg.includeDebug ? contributions : undefined,
        highlights: [],
        matchMeta: { reason: "no_overlap" },
      };
    }

    // Phrase + ordered bonuses using combined doc text
    const phrase = phraseHit(doc.combinedNorm, q.norm);
    const ordered = orderBonus(doc.combinedNorm, q.norm, uniq(q.tokens));
    if (phrase) raw += raw * cfg.phraseBonus;
    if (ordered) raw += raw * cfg.orderedBonus;

    // Preference boosts
    let tagBoost = 0;
    let domainBoost = 0;
    let typeBoost = 0;

    if (prefDomain && item.domain && String(item.domain) === prefDomain) {
      domainBoost = cfg.domainMatchBonus;
      raw += raw * domainBoost;
    }

    if (prefTypes.length && item.type) {
      const t = String(item.type);
      if (prefTypes.includes(t)) {
        typeBoost = cfg.typeMatchBonus;
        raw += raw * typeBoost;
      }
    }

    if (prefTags.length && Array.isArray(item.tags) && item.tags.length) {
      const set = new Set(item.tags.map(String));
      let hits = 0;
      for (let i = 0; i < prefTags.length; i++) {
        if (set.has(prefTags[i])) hits++;
      }
      if (hits > 0) {
        // scale: more hits, slightly more boost but capped
        tagBoost = Math.min(0.22, cfg.tagMatchBonus + hits * 0.03);
        raw += raw * tagBoost;
      }
    }

    // Optional mild recency nudge (small, deterministic, never dominates)
    const updatedAt = safeNumberTime(item.updatedAt);
    if (updatedAt) {
      const ageDays = Math.max(
        0,
        (nowMs() - updatedAt) / (24 * 60 * 60 * 1000)
      );
      // 0 days => ~+4%, 90 days => ~+1%, 365 days => ~+0.3%
      const recencyBoost = Math.max(0.003, 0.04 * Math.exp(-ageDays / 120));
      raw += raw * recencyBoost;
      if (cfg.includeDebug) contributions._recency = raw * recencyBoost;
    }

    // Penalize very weak overlap for longer queries (helps reduce false positives)
    const overlap = doc.tokenSetOverlap(q.tokenSet);
    const qLen = q.tokens.length;
    const overlapRatio = qLen
      ? overlap / Math.max(1, uniq(q.tokens).length)
      : 0;
    if (qLen >= 5 && overlapRatio < 0.25) {
      const penalty = 0.1 + (0.25 - overlapRatio) * 0.35; // up to ~20-25%
      raw *= Math.max(0.55, 1 - penalty);
      if (cfg.includeDebug) contributions._lowOverlapPenalty = -penalty;
    }

    const highlights = cfg.includeHighlights
      ? buildHighlights(item, q.tokens, cfg)
      : [];

    return {
      item,
      score: 0, // filled later
      rawScore: raw,
      contributions: cfg.includeDebug ? contributions : undefined,
      highlights,
      matchMeta: {
        phraseHit: !!phrase,
        orderedHit: !!ordered,
        overlap,
        overlapRatio: Number(overlapRatio.toFixed(3)),
        tagBoost: Number(tagBoost.toFixed(3)),
        domainBoost: Number(domainBoost.toFixed(3)),
        typeBoost: Number(typeBoost.toFixed(3)),
      },
    };
  }

  _rebuildIndex() {
    const cfg = this.cfg;

    this._doc.clear();
    this._df.clear();

    const items = this._items;
    let totalLen = 0;
    let docCount = 0;

    // fingerprint: stable-ish based on ids + updatedAt + counts
    let fpSeed = 2166136261;

    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (!it || !it.id) continue;

      const prep = this._prepareDoc(it, cfg);
      this._doc.set(it.id, prep);

      // doc freq merge across combined tokens
      mergeDf(this._df, prep.combinedTf);

      totalLen += prep.combinedLen;
      docCount++;

      // update fingerprint
      const idStr = String(it.id);
      fpSeed = (fpSeed ^ stableHash32(idStr)) >>> 0;
      const u = safeNumberTime(it.updatedAt) || 0;
      fpSeed = (fpSeed ^ (u >>> 0)) >>> 0;
      fpSeed =
        (fpSeed +
          (fpSeed << 1) +
          (fpSeed << 4) +
          (fpSeed << 7) +
          (fpSeed << 8) +
          (fpSeed << 24)) >>>
        0;
    }

    this._avgLen = docCount ? totalLen / docCount : 1;
    this._idf = idfFromDf(this._df, docCount);

    // incorporate docCount in fingerprint
    fpSeed = (fpSeed ^ (docCount >>> 0)) >>> 0;
    this._fingerprint = fpSeed >>> 0;
  }

  _prepareDoc(item, cfg) {
    const maxChars = cfg.maxTextCharsPerField;

    const fieldText = {
      title:
        buildFieldText(item, "title", maxChars) ||
        buildFieldText(item, "name", maxChars),
      tags: buildFieldText(item, "tags", maxChars),
      keywords: buildFieldText(item, "keywords", maxChars),
      summary: buildFieldText(item, "summary", maxChars),
      steps: buildFieldText(item, "steps", maxChars),
      body: buildFieldText(item, "body", maxChars),
      domain: item.domain ? String(item.domain) : "",
      type: item.type ? String(item.type) : "",
      source: item.source ? String(item.source) : "",
    };

    const fields = {};
    const combinedTokens = [];

    Object.keys(fieldText).forEach((f) => {
      const t = fieldText[f];
      const toks = tokenize(t, { maxTokens: 800 });
      const tf = computeTf(toks);
      const len = toks.length;

      fields[f] = {
        tf,
        len,
      };

      // Combine only content-heavy fields into combined tokens;
      // include domain/type lightly through scoring, but not in combined overlap.
      if (
        f === "title" ||
        f === "tags" ||
        f === "keywords" ||
        f === "summary" ||
        f === "steps" ||
        f === "body"
      ) {
        for (let i = 0; i < toks.length; i++) combinedTokens.push(toks[i]);
      }
    });

    const combinedTf = computeTf(combinedTokens);
    const combinedLen = combinedTokens.length;

    const combinedNorm = normalizeText(
      [
        fieldText.title,
        fieldText.tags,
        fieldText.keywords,
        fieldText.summary,
        fieldText.steps,
        fieldText.body,
      ]
        .filter(Boolean)
        .join(" ")
    );

    const combinedSet = new Set(combinedTokens);

    return {
      id: item.id,
      fields,
      combinedTf,
      combinedLen,
      combinedNorm,
      tokenSetOverlap: (qSet) => {
        // Count unique overlaps between doc and query tokens
        let c = 0;
        qSet.forEach((t) => {
          if (combinedSet.has(t)) c++;
        });
        return c;
      },
    };
  }
}

/* -----------------------------------------------------------------------------
 * Factory helpers
 * -------------------------------------------------------------------------- */

/**
 * Create a matcher with items already loaded.
 */
export function createContextMatcher(items = [], options = {}) {
  const m = new ContextMatcher(options);
  m.setItems(items);
  return m;
}

/**
 * Simple one-shot match (no reuse). Good for small lists.
 */
export function matchContext(items, query, options = {}) {
  const m = createContextMatcher(items, options);
  return m.match({ query, options });
}

export default ContextMatcher;
