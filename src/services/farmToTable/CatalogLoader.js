// C:\Users\larho\suka-smart-assistant\src\services\farmToTable\CatalogLoader.js
/* eslint-disable no-console */
/**
 * SSA • Farm-to-Table / Homestead CatalogLoader
 * -----------------------------------------------------------------------------
 * Browser-safe loader for component + preservation catalogs used by:
 *  - Homestead Planner: components.jsx (catalog browser)
 *  - Inventory readiness + shelf life mapping
 *  - Preservation batch templates
 *
 * Core responsibilities
 *  1) Load catalog data from:
 *      - local JSON modules (bundled with Vite)
 *      - optional remote URL (feature-flagged)
 *      - optional raw JSON passed in
 *  2) Normalize and validate into a stable internal schema.
 *  3) Cache:
 *      - in-memory (fast)
 *      - optional Dexie table (if available in your DB)
 *      - localStorage fallback (small metadata only)
 *  4) Provide search/filter helpers:
 *      - query text search
 *      - tag filtering
 *      - category/method filtering
 *  5) Emit SSA events so pages can refresh automatically.
 *
 * Events
 *  - ssa.catalog.loaded
 *  - ssa.catalog.error
 *  - ssa.catalog.updated (when remote refresh changes hash)
 *
 * IMPORTANT (no Node imports)
 *  - Uses fetch, Web Crypto (fallback hashing), and safe parsing.
 *
 * Expected normalized record shapes
 *  CatalogBundle:
 *    {
 *      meta: { id, title, version, source, loadedAt, hash, counts }
 *      components: CatalogComponent[]
 *      methods: PreservationMethod[]
 *      tags: string[]
 *      categories: string[]
 *    }
 *
 *  CatalogComponent:
 *    {
 *      id, name, nameLower, category, categoryLower,
 *      description, tags: string[],
 *      shelfLife: { pantryDays?, fridgeDays?, freezerDays?, notes? } | null,
 *      preservationMethods: string[] (method ids),
 *      inputs?: string[] (component ids),
 *      outputs?: string[] (component ids),
 *      links?: { type, label, href }[]
 *      defaults?: { unit?, yieldRatio?, batchSize? }
 *      nutritionHints?: { caloriesPerUnit?, macros?, allergens? } (optional)
 *    }
 *
 *  PreservationMethod:
 *    {
 *      id, name, nameLower,
 *      category, categoryLower, // e.g., canning / dehydrating / fermenting
 *      description,
 *      tags: string[],
 *      requirements?: string[],
 *      safety?: { critical?: string[], notes?: string[] },
 *      typicalShelfLife?: { pantryDays?, fridgeDays?, freezerDays?, notes? } | null
 *    }
 */

const SOURCE = "services/farmToTable/CatalogLoader";

/** Optional default local catalog paths (you can add these JSON files later). */
const DEFAULT_LOCAL_SOURCES = [
  // Prefer your homesteadplanner catalogs if present:
  // { id: "homestead.components", type: "url", url: "/catalogs/homestead/components.json" },
  // { id: "homestead.methods", type: "url", url: "/catalogs/homestead/preservation-methods.json" },
];

/** In-memory cache */
const mem = {
  bundle: null,
  byId: null,
  methodsById: null,
  lastError: null,
};

const DEFAULTS = {
  bundleId: "ssa.homestead.catalog",
  title: "Homestead Catalog",
  version: "1.0.0",
  // If you pass remoteUrl it will be used; otherwise local sources only.
  remoteUrl: null,
  // remote refresh behavior
  allowRemote: false,
  remoteTimeoutMs: 9000,
  // caching
  cache: {
    memory: true,
    dexie: true, // only if db.table exists
    localStorageMeta: true,
  },
  // search behavior
  search: {
    minQueryLen: 1,
    maxResults: 250,
  },
};

/* -----------------------------------------------------------------------------
 * Public API
 * --------------------------------------------------------------------------- */

export const CatalogLoader = {
  loadCatalog,
  getCached,
  clearCache,
  searchComponents,
  searchMethods,
  getComponentById,
  getMethodById,
  getTagIndex,
  getCategoryIndex,
};

/**
 * Load a catalog bundle from local + optional remote sources.
 *
 * @param {object} opts
 * @param {object} [opts.db] - Dexie db instance (optional)
 * @param {string} [opts.bundleId]
 * @param {string} [opts.title]
 * @param {string} [opts.version]
 * @param {Array}  [opts.sources] - array of sources { id, type: 'url'|'json', url?, json? }
 * @param {string} [opts.remoteUrl]
 * @param {boolean}[opts.allowRemote]
 * @param {number} [opts.remoteTimeoutMs]
 * @param {object} [opts.cache]
 * @returns {Promise<CatalogBundle>}
 */
async function loadCatalog(opts = {}) {
  const cfg = {
    ...DEFAULTS,
    ...opts,
    cache: { ...DEFAULTS.cache, ...(opts.cache || {}) },
    search: { ...DEFAULTS.search, ...(opts.search || {}) },
  };

  const sources =
    Array.isArray(cfg.sources) && cfg.sources.length
      ? cfg.sources
      : DEFAULT_LOCAL_SOURCES;

  try {
    // 1) Load local pieces (components + methods) and merge
    const localPieces = await Promise.all(
      sources.map((s) => loadSourceSafe(s))
    );

    // 2) If remote allowed, attempt remote (as a full bundle OR pieces)
    let remotePiece = null;
    if (cfg.allowRemote && cfg.remoteUrl) {
      remotePiece = await loadRemoteBundle(cfg.remoteUrl, cfg.remoteTimeoutMs);
    }

    // 3) Merge: remote overrides local if present
    const mergedRaw = mergeRawPieces(localPieces, remotePiece);

    // 4) Normalize + validate
    const normalized = normalizeBundle(mergedRaw, cfg);

    // 5) Hash & meta
    const hash = await hashBundle(normalized);
    normalized.meta.hash = hash;
    normalized.meta.loadedAt = new Date().toISOString();

    // 6) Cache + emit events
    await cacheBundle(normalized, cfg);

    // Emit updated vs loaded
    const prevHash = readMetaHashLS(cfg.bundleId);
    if (prevHash && prevHash !== hash) {
      emit("ssa.catalog.updated", {
        source: SOURCE,
        bundleId: cfg.bundleId,
        prevHash,
        hash,
        loadedAt: normalized.meta.loadedAt,
      });
    }
    emit("ssa.catalog.loaded", {
      source: SOURCE,
      bundleId: cfg.bundleId,
      hash,
      counts: normalized.meta.counts,
      loadedAt: normalized.meta.loadedAt,
    });

    return normalized;
  } catch (err) {
    mem.lastError = err;
    emit("ssa.catalog.error", {
      source: SOURCE,
      bundleId: cfg.bundleId,
      message: err?.message || String(err),
    });
    throw err;
  }
}

/**
 * Return cached catalog bundle if present (memory first, then Dexie, then localStorage meta)
 * @param {object} opts
 * @param {object} [opts.db]
 * @param {string} [opts.bundleId]
 */
async function getCached(opts = {}) {
  const cfg = {
    ...DEFAULTS,
    ...opts,
    cache: { ...DEFAULTS.cache, ...(opts.cache || {}) },
  };
  if (mem.bundle && cfg.cache.memory) return mem.bundle;

  // Try Dexie if available
  const db = opts.db;
  if (cfg.cache.dexie && db && db.catalogBundles) {
    try {
      const row = await db.catalogBundles.get(cfg.bundleId);
      if (row?.bundle) {
        const b = row.bundle;
        // hydrate indexes in memory
        setMemBundle(b);
        return b;
      }
    } catch (e) {
      // ignore
    }
  }

  // localStorage meta cannot store whole bundle reliably (size); return null
  return null;
}

/**
 * Clear caches
 */
async function clearCache(opts = {}) {
  const cfg = {
    ...DEFAULTS,
    ...opts,
    cache: { ...DEFAULTS.cache, ...(opts.cache || {}) },
  };

  mem.bundle = null;
  mem.byId = null;
  mem.methodsById = null;
  mem.lastError = null;

  if (cfg.cache.localStorageMeta) {
    try {
      window?.localStorage?.removeItem(metaKey(cfg.bundleId));
    } catch (e) {}
  }

  // Dexie
  const db = opts.db;
  if (cfg.cache.dexie && db && db.catalogBundles) {
    try {
      await db.catalogBundles.delete(cfg.bundleId);
    } catch (e) {}
  }

  emit("ssa.catalog.updated", {
    source: SOURCE,
    bundleId: cfg.bundleId,
    cleared: true,
  });
}

/**
 * Search components
 */
function searchComponents(bundle, query, filters = {}, limit) {
  const b = bundle || mem.bundle;
  if (!b) return [];

  const q = toLower(query || "");
  const max = Number.isFinite(limit) ? limit : DEFAULTS.search.maxResults;

  const tagSet = normalizeFilterSet(filters.tags);
  const categorySet = normalizeFilterSet(filters.categories);
  const methodSet = normalizeFilterSet(filters.methods);

  const out = [];
  for (const c of b.components || []) {
    if (q && !componentMatches(c, q)) continue;
    if (tagSet.size && !hasAnyTag(c.tags, tagSet)) continue;
    if (categorySet.size && !categorySet.has(toLower(c.category))) continue;
    if (methodSet.size && !hasAnyMethod(c.preservationMethods, methodSet))
      continue;

    out.push(c);
    if (out.length >= max) break;
  }

  return out;
}

/**
 * Search preservation methods
 */
function searchMethods(bundle, query, filters = {}, limit) {
  const b = bundle || mem.bundle;
  if (!b) return [];

  const q = toLower(query || "");
  const max = Number.isFinite(limit) ? limit : DEFAULTS.search.maxResults;

  const tagSet = normalizeFilterSet(filters.tags);
  const categorySet = normalizeFilterSet(filters.categories);

  const out = [];
  for (const m of b.methods || []) {
    if (q && !methodMatches(m, q)) continue;
    if (tagSet.size && !hasAnyTag(m.tags, tagSet)) continue;
    if (categorySet.size && !categorySet.has(toLower(m.category))) continue;

    out.push(m);
    if (out.length >= max) break;
  }

  return out;
}

/**
 * Get component by id
 */
function getComponentById(bundle, id) {
  const b = bundle || mem.bundle;
  if (!b) return null;
  const key = toLower(id);
  if (!key) return null;
  if (!mem.byId) setMemBundle(b);
  return mem.byId.get(key) || null;
}

/**
 * Get method by id
 */
function getMethodById(bundle, id) {
  const b = bundle || mem.bundle;
  if (!b) return null;
  const key = toLower(id);
  if (!key) return null;
  if (!mem.methodsById) setMemBundle(b);
  return mem.methodsById.get(key) || null;
}

function getTagIndex(bundle) {
  const b = bundle || mem.bundle;
  return b?.tags || [];
}
function getCategoryIndex(bundle) {
  const b = bundle || mem.bundle;
  return b?.categories || [];
}

/* -----------------------------------------------------------------------------
 * Source loading
 * --------------------------------------------------------------------------- */

async function loadSourceSafe(source) {
  if (!source) return null;
  const type =
    source.type || (source.url ? "url" : source.json ? "json" : "unknown");
  const id = source.id || "source";

  try {
    if (type === "json") return { id, raw: source.json };
    if (type === "url") {
      const json = await fetchJson(source.url, 7000);
      return { id, raw: json };
    }
    return { id, raw: null };
  } catch (e) {
    console.warn(`[CatalogLoader] source failed (${id}):`, e);
    return { id, raw: null, error: e?.message || String(e) };
  }
}

async function loadRemoteBundle(url, timeoutMs) {
  try {
    const json = await fetchJson(url, timeoutMs);
    return { id: "remote", raw: json };
  } catch (e) {
    console.warn("[CatalogLoader] remote failed:", e);
    return null;
  }
}

async function fetchJson(url, timeoutMs = 8000) {
  if (!url) throw new Error("Missing URL for catalog source.");
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal,
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`Catalog fetch failed (${res.status})`);
    const text = await res.text();
    return safeJsonParse(text);
  } finally {
    clearTimeout(t);
  }
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch (e) {
    // attempt to recover from BOM / stray characters
    const cleaned = String(text || "")
      .replace(/^\uFEFF/, "")
      .trim();
    return JSON.parse(cleaned);
  }
}

/* -----------------------------------------------------------------------------
 * Merge + Normalize
 * --------------------------------------------------------------------------- */

function mergeRawPieces(localPieces, remotePiece) {
  // Accept two styles:
  //  A) Full bundle: { meta, components, methods }
  //  B) Pieces: components array or methods array, or nested keys
  const pieces = (localPieces || []).filter(Boolean);

  const merged = {
    meta: {},
    components: [],
    methods: [],
    tags: [],
    categories: [],
  };

  // Merge locals first
  for (const p of pieces) {
    mergeInto(merged, p?.raw);
  }
  // Remote overrides after
  if (remotePiece?.raw) mergeInto(merged, remotePiece.raw);

  return merged;
}

function mergeInto(target, raw) {
  if (!raw) return;

  // If raw is an array, guess what it is (components or methods)
  if (Array.isArray(raw)) {
    // Heuristic: if objects have "method" or "requirements" treat as methods
    const first = raw[0] || {};
    const looksLikeMethod = !!(
      first?.requirements ||
      first?.safety ||
      first?.categoryLower === "canning"
    );
    if (looksLikeMethod) target.methods = target.methods.concat(raw);
    else target.components = target.components.concat(raw);
    return;
  }

  // If full bundle-ish:
  if (raw.meta) target.meta = { ...target.meta, ...raw.meta };
  if (Array.isArray(raw.components))
    target.components = target.components.concat(raw.components);
  if (Array.isArray(raw.methods))
    target.methods = target.methods.concat(raw.methods);

  // Alternative keys
  if (Array.isArray(raw.items))
    target.components = target.components.concat(raw.items);
  if (Array.isArray(raw.preservationMethods))
    target.methods = target.methods.concat(raw.preservationMethods);

  if (Array.isArray(raw.tags)) target.tags = target.tags.concat(raw.tags);
  if (Array.isArray(raw.categories))
    target.categories = target.categories.concat(raw.categories);
}

/**
 * Normalize into stable bundle shape
 */
function normalizeBundle(raw, cfg) {
  const metaIn = raw?.meta || {};
  const bundle = {
    meta: {
      id: cfg.bundleId,
      title: metaIn.title || cfg.title,
      version: String(metaIn.version || cfg.version || "1.0.0"),
      source: metaIn.source || "local",
      loadedAt: null,
      hash: null,
      counts: { components: 0, methods: 0, tags: 0, categories: 0 },
    },
    components: [],
    methods: [],
    tags: [],
    categories: [],
  };

  // Normalize methods first (so component method ids can be validated)
  const methods = uniqById(
    (raw?.methods || []).map(normalizeMethod).filter(Boolean)
  );
  const methodsById = new Map(methods.map((m) => [toLower(m.id), m]));

  const components = uniqById(
    (raw?.components || [])
      .map((c) => normalizeComponent(c, methodsById))
      .filter(Boolean)
  );

  // Derive tags/categories if not present
  const tags = uniq([
    ...(raw?.tags || []),
    ...components.flatMap((c) => c.tags || []),
    ...methods.flatMap((m) => m.tags || []),
  ])
    .map(toLower)
    .filter(Boolean)
    .sort();

  const categories = uniq([
    ...(raw?.categories || []),
    ...components.map((c) => c.category),
    ...methods.map((m) => m.category),
  ])
    .map((x) => (x == null ? "" : String(x)).trim())
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));

  bundle.components = components;
  bundle.methods = methods;
  bundle.tags = tags;
  bundle.categories = categories;

  bundle.meta.counts = {
    components: components.length,
    methods: methods.length,
    tags: tags.length,
    categories: categories.length,
  };

  // Set memory indexes
  setMemBundle(bundle);

  return bundle;
}

function normalizeComponent(raw, methodsById) {
  if (!raw) return null;

  // Accept minimal shapes
  const name = String(raw.name || raw.title || raw.id || "").trim();
  if (!name) return null;

  const id = String(raw.id || slugify(name)).trim();
  const category = String(raw.category || raw.group || "General").trim();

  const tags = uniq([
    ...(Array.isArray(raw.tags) ? raw.tags : []),
    ...(Array.isArray(raw.keywords) ? raw.keywords : []),
  ])
    .map((t) => String(t).trim())
    .filter(Boolean);

  const preservationMethodsRaw = uniq(
    Array.isArray(raw.preservationMethods)
      ? raw.preservationMethods
      : Array.isArray(raw.methods)
      ? raw.methods
      : []
  )
    .map((m) => String(m).trim())
    .filter(Boolean);

  // Validate method ids against method registry if provided; keep unknowns but mark
  const preservationMethods = [];
  for (const mid of preservationMethodsRaw) {
    const key = toLower(mid);
    if (methodsById && methodsById.size) {
      if (methodsById.has(key))
        preservationMethods.push(methodsById.get(key).id);
      else preservationMethods.push(mid); // allow unknown; UI can still show it
    } else {
      preservationMethods.push(mid);
    }
  }

  const shelfLife = normalizeShelfLife(
    raw.shelfLife || raw.shelf_life || raw.shelf || null
  );

  const links = normalizeLinks(raw.links);
  const defaults = normalizeDefaults(raw.defaults);
  const inputs = normalizeIdArray(raw.inputs);
  const outputs = normalizeIdArray(raw.outputs);

  return {
    id,
    name,
    nameLower: toLower(name),
    category,
    categoryLower: toLower(category),
    description: String(raw.description || raw.desc || "").trim(),
    tags,
    shelfLife,
    preservationMethods,
    inputs,
    outputs,
    links,
    defaults,
    nutritionHints: raw.nutritionHints || raw.nutrition || null,
  };
}

function normalizeMethod(raw) {
  if (!raw) return null;
  const name = String(raw.name || raw.title || raw.id || "").trim();
  if (!name) return null;
  const id = String(raw.id || slugify(name)).trim();
  const category = String(raw.category || raw.group || "Preservation").trim();

  const tags = uniq([
    ...(Array.isArray(raw.tags) ? raw.tags : []),
    ...(Array.isArray(raw.keywords) ? raw.keywords : []),
  ])
    .map((t) => String(t).trim())
    .filter(Boolean);

  return {
    id,
    name,
    nameLower: toLower(name),
    category,
    categoryLower: toLower(category),
    description: String(raw.description || raw.desc || "").trim(),
    tags,
    requirements: normalizeStringArray(raw.requirements),
    safety: normalizeSafety(raw.safety),
    typicalShelfLife: normalizeShelfLife(
      raw.typicalShelfLife || raw.shelfLife || null
    ),
  };
}

function normalizeShelfLife(raw) {
  if (!raw) return null;
  if (typeof raw === "string") return { notes: raw };

  const pantryDays = safeNum(raw.pantryDays ?? raw.pantry_days ?? raw.pantry);
  const fridgeDays = safeNum(raw.fridgeDays ?? raw.fridge_days ?? raw.fridge);
  const freezerDays = safeNum(
    raw.freezerDays ?? raw.freezer_days ?? raw.freezer
  );

  const notes = String(raw.notes || raw.note || "").trim();

  // If none numeric and no notes, return null
  const hasAny =
    Number.isFinite(pantryDays) ||
    Number.isFinite(fridgeDays) ||
    Number.isFinite(freezerDays) ||
    !!notes;
  if (!hasAny) return null;

  return {
    ...(Number.isFinite(pantryDays) ? { pantryDays } : {}),
    ...(Number.isFinite(fridgeDays) ? { fridgeDays } : {}),
    ...(Number.isFinite(freezerDays) ? { freezerDays } : {}),
    ...(notes ? { notes } : {}),
  };
}

function normalizeSafety(raw) {
  if (!raw) return null;
  if (typeof raw === "string") return { notes: [raw] };
  const critical = normalizeStringArray(raw.critical);
  const notes = normalizeStringArray(raw.notes);
  if (!critical.length && !notes.length) return null;
  return {
    ...(critical.length ? { critical } : {}),
    ...(notes.length ? { notes } : {}),
  };
}

function normalizeLinks(raw) {
  if (!raw) return [];
  const arr = Array.isArray(raw) ? raw : [raw];
  return arr
    .map((l) => {
      if (!l) return null;
      if (typeof l === "string") return { type: "link", label: l, href: l };
      const href = String(l.href || l.url || "").trim();
      if (!href) return null;
      return {
        type: String(l.type || "link").trim(),
        label: String(l.label || l.title || href).trim(),
        href,
      };
    })
    .filter(Boolean);
}

function normalizeDefaults(raw) {
  if (!raw || typeof raw !== "object") return null;
  const unit = safeStr(raw.unit);
  const yieldRatio = safeNum(raw.yieldRatio ?? raw.yield_ratio, null);
  const batchSize = safeNum(raw.batchSize ?? raw.batch_size, null);
  const out = {};
  if (unit) out.unit = unit;
  if (Number.isFinite(yieldRatio)) out.yieldRatio = yieldRatio;
  if (Number.isFinite(batchSize)) out.batchSize = batchSize;
  return Object.keys(out).length ? out : null;
}

function normalizeIdArray(raw) {
  if (!raw) return [];
  const arr = Array.isArray(raw) ? raw : [raw];
  return uniq(arr.map((x) => String(x).trim()).filter(Boolean));
}

function normalizeStringArray(raw) {
  if (!raw) return [];
  const arr = Array.isArray(raw) ? raw : [raw];
  return arr.map((x) => String(x).trim()).filter(Boolean);
}

function uniqById(items) {
  const seen = new Set();
  const out = [];
  for (const it of items || []) {
    const id = toLower(it?.id);
    if (!id) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(it);
  }
  return out;
}

/* -----------------------------------------------------------------------------
 * Matching + filtering
 * --------------------------------------------------------------------------- */

function componentMatches(c, q) {
  if (!q) return true;
  const hay = `${c.nameLower} ${c.categoryLower} ${(c.tags || [])
    .map(toLower)
    .join(" ")} ${toLower(c.description)}`;
  return hay.includes(q);
}

function methodMatches(m, q) {
  if (!q) return true;
  const hay = `${m.nameLower} ${m.categoryLower} ${(m.tags || [])
    .map(toLower)
    .join(" ")} ${toLower(m.description)}`;
  return hay.includes(q);
}

function normalizeFilterSet(val) {
  const arr = Array.isArray(val) ? val : val ? [val] : [];
  return new Set(arr.map((x) => toLower(String(x))).filter(Boolean));
}

function hasAnyTag(tags, tagSet) {
  for (const t of tags || []) {
    if (tagSet.has(toLower(t))) return true;
  }
  return false;
}

function hasAnyMethod(methods, methodSet) {
  for (const m of methods || []) {
    if (methodSet.has(toLower(m))) return true;
  }
  return false;
}

/* -----------------------------------------------------------------------------
 * Caching
 * --------------------------------------------------------------------------- */

async function cacheBundle(bundle, cfg) {
  if (!bundle) return;

  if (cfg.cache.memory) setMemBundle(bundle);

  if (cfg.cache.localStorageMeta) {
    try {
      window?.localStorage?.setItem(
        metaKey(cfg.bundleId),
        JSON.stringify({
          bundleId: cfg.bundleId,
          hash: bundle.meta.hash,
          loadedAt: bundle.meta.loadedAt,
          counts: bundle.meta.counts,
          version: bundle.meta.version,
          title: bundle.meta.title,
        })
      );
    } catch (e) {
      // ignore
    }
  }

  // Dexie: store bundle as an object; relies on your DB having `catalogBundles` table.
  // Suggested Dexie store:
  //  catalogBundles: "&id, updatedAt, hash"
  // row shape:
  //  { id, updatedAt, hash, bundle }
  const db = cfg.db;
  if (cfg.cache.dexie && db && db.catalogBundles) {
    try {
      await db.catalogBundles.put({
        id: cfg.bundleId,
        updatedAt: bundle.meta.loadedAt,
        hash: bundle.meta.hash,
        bundle,
      });
    } catch (e) {
      // ignore to avoid breaking UI if db schema not present yet
    }
  }
}

function setMemBundle(bundle) {
  mem.bundle = bundle;
  mem.byId = new Map((bundle.components || []).map((c) => [toLower(c.id), c]));
  mem.methodsById = new Map(
    (bundle.methods || []).map((m) => [toLower(m.id), m])
  );
}

/* -----------------------------------------------------------------------------
 * Hashing
 * --------------------------------------------------------------------------- */

async function hashBundle(bundle) {
  // Hash only the content arrays, not loadedAt/hash itself.
  const payload = {
    meta: {
      id: bundle?.meta?.id,
      title: bundle?.meta?.title,
      version: bundle?.meta?.version,
    },
    components: bundle?.components || [],
    methods: bundle?.methods || [],
    tags: bundle?.tags || [],
    categories: bundle?.categories || [],
  };
  const json = stableStringify(payload);

  // WebCrypto SHA-256 if available
  try {
    const enc = new TextEncoder();
    const data = enc.encode(json);
    const digest = await crypto.subtle.digest("SHA-256", data);
    return bufferToHex(digest);
  } catch (e) {
    // fallback: simple hash (not cryptographic)
    return simpleHash(json);
  }
}

function bufferToHex(buf) {
  const bytes = new Uint8Array(buf);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}

function simpleHash(str) {
  // FNV-1a-ish
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `h${(h >>> 0).toString(16)}`;
}

function stableStringify(obj) {
  // Deterministic JSON stringify (small, sufficient for catalogs)
  return JSON.stringify(sortKeysDeep(obj));
}

function sortKeysDeep(x) {
  if (Array.isArray(x)) return x.map(sortKeysDeep);
  if (x && typeof x === "object") {
    const out = {};
    Object.keys(x)
      .sort()
      .forEach((k) => {
        out[k] = sortKeysDeep(x[k]);
      });
    return out;
  }
  return x;
}

/* -----------------------------------------------------------------------------
 * Utilities
 * --------------------------------------------------------------------------- */

function slugify(s) {
  return String(s || "")
    .toLowerCase()
    .trim()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function safeNum(v, fallback = 0) {
  if (v == null || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function toLower(s) {
  return (typeof s === "string" ? s : s == null ? "" : String(s))
    .trim()
    .toLowerCase();
}

function uniq(arr) {
  return Array.from(
    new Set((arr || []).map((x) => String(x || "").trim()).filter(Boolean))
  );
}

function emit(type, detail) {
  try {
    if (typeof window !== "undefined" && window.eventBus?.emit)
      window.eventBus.emit(type, detail);
  } catch (e) {}
  try {
    if (typeof window !== "undefined")
      window.dispatchEvent(new CustomEvent(type, { detail }));
  } catch (e) {}
}

/* -----------------------------------------------------------------------------
 * localStorage meta helpers
 * --------------------------------------------------------------------------- */

function metaKey(bundleId) {
  return `ssa.catalog.meta.${bundleId || DEFAULTS.bundleId}`;
}
function readMetaHashLS(bundleId) {
  try {
    const raw = window?.localStorage?.getItem(metaKey(bundleId));
    if (!raw) return null;
    const obj = JSON.parse(raw);
    return obj?.hash || null;
  } catch (e) {
    return null;
  }
}
