/* eslint-disable no-console */
// StoreCatalogAdapters.js — live prices per store (adapter hub + caching + favorites)
// ESM-compatible. Dependency-light. All deps are optional & safe by default.

/**
 * Normalized Offer (aligned with PriceComparator):
 * {
 *   id: string,
 *   title: string,
 *   store: { id:string, name:string, loyaltyTier?: "member"|"plus"|null, distanceKm?:number },
 *   price: { amount:number, currency:"USD"|string, includesTax?:boolean, taxRate?:number },
 *   sizeText?: string,
 *   unit?: { qty:number, uom:string, packCount?:number }, // optional
 *   category?: string,
 *   availability?: "in_stock"|"limited"|"oos",
 *   metadata?: any
 * }
 */

export function createStoreCatalogHub(deps = {}) {
  const {
    fetcher = safeFetch(),            // (url, opts) => Promise<Response> (browser/server)
    eventBus = safeBus(),             // { emit(evt,payload), on?(evt,cb)=>off }
    analytics = safeAnalytics(),      // { track(evt,payload) }
    prefs = safePrefs(),              // local persistence (or Dexie/Zustand adapter)
    clock = { now: () => Date.now() },
    config = { get: (_p, fb) => fb },
    geo = null,                       // optional: { getDistanceKm(storeLatLon) }
  } = deps;

  const NS = "scanCompareTrust.catalogHub";
  const CACHE_KEY = `${NS}.cache.v1`;                 // cached responses by key
  const PROFILE_KEY = `${NS}.profile.v1`;             // active profile (stores, zip, radius, cadence)
  const FAVORITES_KEY = `${NS}.favorites.v1`;         // saved sessions

  // in-memory LRU-ish cache (mirrored to prefs)
  let cache = hydrateCache();
  let adapters = new Map(); // name → adapter
  let activeProfile = hydrateProfile();
  let favorites = hydrateFavorites();

  // per-adapter concurrency guard
  const inflight = new Map(); // key → Promise
  const queues = new Map();   // adapterName → { max:number, q:[] }

  // ---- PUBLIC API ------------------------------------------------------------

  return {
    // Adapter lifecycle
    registerAdapter,
    listAdapters,
    hasAdapter,

    // Fetch
    lookupByBarcode,
    lookupByQuery,
    lookupAcrossStores,

    // Higher-level: fetch → normalize → compare (one call)
    resolveAndCompare,

    // Favorites & Profile (users can save sessions/schedules)
    getActiveProfile,
    setActiveProfile,
    exportProfile,
    importProfile,
    listFavoriteSessions,
    saveFavoriteSession,
    deleteFavoriteSession,
    runFavoriteSession,

    // Utilities
    setAdapterConcurrency,
    invalidateCacheKey,
    clearCache,
    getVersion,
  };

  function getVersion() { return "2.3.0"; }

  // ---- ADAPTERS --------------------------------------------------------------

  /**
   * Adapter shape:
   * {
   *   name: "walmart",
   *   displayName: "Walmart",
   *   supports: ({ type }) => boolean, // type: "barcode"|"query"
   *   lookupByBarcode: async (barcode, ctx) => Offer[],
   *   lookupByQuery:   async (query, ctx) => Offer[],
   *   ttlMs?: number,                      // default cache TTL
   *   concurrency?: number                 // default max concurrent calls
   * }
   */
  function registerAdapter(adapter) {
    if (!adapter?.name) throw new Error("Adapter must have a name");
    adapters.set(adapter.name, materializeAdapter(adapter));
    if (adapter.concurrency) setAdapterConcurrency(adapter.name, adapter.concurrency);
    eventBus.emit("catalog:adapter:registered", { name: adapter.name, ts: clock.now() });
  }
  function listAdapters() { return Array.from(adapters.values()).map(presentAdapter); }
  function hasAdapter(name) { return adapters.has(name); }

  // ---- LOOKUPS ---------------------------------------------------------------

  async function lookupByBarcode(storeName, barcode, ctx = {}) {
    return guardedLookup("barcode", storeName, barcode, ctx);
  }
  async function lookupByQuery(storeName, query, ctx = {}) {
    return guardedLookup("query", storeName, query, ctx);
  }

  async function lookupAcrossStores({ type, value, stores, ctx = {} }) {
    const targets = (stores && stores.length ? stores : activeProfile.storeIds) || [];
    const tasks = targets
      .filter((s) => adapters.has(s))
      .map((s) => guardedLookup(type, s, value, ctx).catch((e) => {
        // swallow per-store errors to allow others to complete
        eventBus.emit("catalog:fetch:error", { store: s, type, value, error: toErr(e), ts: clock.now() });
        return [];
      }));
    const results = (await Promise.all(tasks)).flat();
    eventBus.emit("catalog:fetch:done", { type, value, stores: targets, count: results.length, ts: clock.now() });
    analytics.track?.("catalog_fetch_multi", { type, count: results.length, stores: targets.length });
    return results;
  }

  // One-shot pipeline: fetch → normalize (via adapters) → compare (if deps provided)
  async function resolveAndCompare({ type, value, stores, ctx = {} }) {
    const offers = await lookupAcrossStores({ type, value, stores, ctx });
    const out = { offers };
    // Optionally flow into comparator if present
    try {
      const { getPriceComparatorSingleton } = await lazyImport("@/features/scan-compare-trust/services/pricing/PriceComparator");
      const { getPriceNormalizerSingleton }  = await lazyImport("@/features/scan-compare-trust/services/pricing/PriceNormalizer");
      const comparator = getPriceComparatorSingleton?.({ eventBus, prefs, config });
      const normalizer = getPriceNormalizerSingleton?.({ eventBus, prefs, config });
      // Attach normalized sizes if available
      const enriched = offers.map((o) => {
        try {
          if (normalizer && !o._normalized) {
            const n = normalizer.coerceOfferSize?.(o);
            return { ...o, _normalized: n };
          }
        } catch (_) {}
        return o;
      });
      const ranked = comparator?.compareOffers?.(enriched, { strategy: comparator?.getActiveProfile?.()?.strategy || "auto" });
      eventBus.emit("pricing:offers:resolved", { count: offers.length, best: ranked?.best?.id || null, ts: clock.now() });
      return ranked || out;
    } catch (_) {
      // comparator/normalizer optional or unavailable
      return out;
    }
  }

  // ---- FAVORITES & PROFILE ---------------------------------------------------

  /**
   * Active profile controls defaults like selected stores, zip, radius, refresh cadence.
   * {
   *   id, label, storeIds: string[], zipcode?: string, radiusKm?: number,
   *   refreshCadence?: "off"|"hourly"|"daily"|"weekly", // UI hint; scheduling handled by your app
   * }
   */
  function getActiveProfile() { return activeProfile; }
  function setActiveProfile(p) {
    activeProfile = materializeProfile(p);
    persistProfile(activeProfile);
    eventBus.emit("catalog:profile:activated", { profileId: activeProfile.id, ts: clock.now() });
  }
  function exportProfile() { return JSON.parse(JSON.stringify(activeProfile)); }
  function importProfile(p) {
    activeProfile = materializeProfile(p);
    persistProfile(activeProfile);
    eventBus.emit("catalog:profile:imported", { profileId: activeProfile.id, ts: clock.now() });
    return true;
  }

  /**
   * Favorite session: user-defined query/barcode + store set (+ label).
   * {
   *   id, label, type:"query"|"barcode", value:string,
   *   stores:string[], zipcode?:string, radiusKm?:number
   * }
   */
  function listFavoriteSessions() { return favorites.slice(); }
  function saveFavoriteSession({ label, type, value, stores, zipcode, radiusKm }) {
    const id = `fav:${Date.now()}`;
    const entry = { id, label: label || `${type}:${value}`, type, value, stores: stores?.length ? stores : activeProfile.storeIds, zipcode: zipcode || activeProfile.zipcode, radiusKm: radiusKm || activeProfile.radiusKm };
    favorites.push(entry);
    persistFavorites(favorites);
    eventBus.emit("catalog:favorites:saved", { id, type, value, stores: entry.stores, ts: clock.now() });
    return id;
  }
  function deleteFavoriteSession(id) {
    const before = favorites.length;
    favorites = favorites.filter((f) => f.id !== id);
    if (favorites.length !== before) {
      persistFavorites(favorites);
      eventBus.emit("catalog:favorites:deleted", { id, ts: clock.now() });
      return true;
    }
    return false;
  }
  async function runFavoriteSession(id, ctx = {}) {
    const fav = favorites.find((f) => f.id === id);
    if (!fav) throw new Error("Favorite session not found");
    return lookupAcrossStores({ type: fav.type, value: fav.value, stores: fav.stores, ctx });
  }

  // ---- INTERNALS: GUARDED LOOKUP + CACHE ------------------------------------

  async function guardedLookup(type, storeName, value, ctx) {
    const adapter = adapters.get(storeName);
    if (!adapter) throw new Error(`Adapter not registered: ${storeName}`);
    if (!adapter.supports({ type })) return [];

    const key = cacheKey(storeName, type, value, ctx?.zipcode, ctx?.radiusKm);
    const now = clock.now();

    // cache hit?
    const hit = cache[key];
    if (hit && now - hit.ts < (adapter.ttlMs || 5 * 60 * 1000)) {
      eventBus.emit("catalog:fetch:cache_hit", { store: storeName, type, value, ts: now });
      return hit.data;
    }

    // de-duplicate inflight
    if (inflight.has(key)) {
      return inflight.get(key);
    }

    const run = withAdapterConcurrency(adapter.name, async () => {
      eventBus.emit("catalog:fetch:start", { store: storeName, type, value, ts: now });
      try {
        const data = await withRetry(async () => {
          const context = {
            fetcher,
            zipcode: ctx?.zipcode || activeProfile.zipcode,
            radiusKm: ctx?.radiusKm || activeProfile.radiusKm,
            geo,
            eventBus,
            config,
          };
          const res = type === "barcode"
            ? (await adapter.lookupByBarcode(value, context)) || []
            : (await adapter.lookupByQuery(value, context)) || [];

          const normalized = (res || []).map(safeNormalizeOffer(adapter.name));
          cache[key] = { ts: clock.now(), data: normalized, ttlMs: adapter.ttlMs || 5 * 60 * 1000 };
          persistCache(cache);
          eventBus.emit("catalog:fetch:success", { store: storeName, type, value, count: normalized.length, ts: clock.now() });
          analytics.track?.("catalog_fetch_success", { store: storeName, type, count: normalized.length });
          return normalized;
        }, { maxAttempts: 3, baseDelayMs: 400, rateLimitDelayMs: adapter.rateLimitDelayMs || 2500 });

        inflight.delete(key);
        return res;
      } catch (e) {
        inflight.delete(key);
        eventBus.emit("catalog:fetch:error", { store: storeName, type, value, error: toErr(e), ts: clock.now() });
        analytics.track?.("catalog_fetch_error", { store: storeName, type, err: toErr(e).message });
        throw e;
      }
    });

    inflight.set(key, run);
    return run;
  }

  function cacheKey(store, type, value, zipcode, radiusKm) {
    return `${store}::${type}::${String(value).trim().toLowerCase()}::${zipcode || ""}::${radiusKm || ""}`;
  }

  function invalidateCacheKey(store, type, value, zipcode, radiusKm) {
    const k = cacheKey(store, type, value, zipcode, radiusKm);
    delete cache[k];
    persistCache(cache);
  }

  function clearCache() {
    cache = {};
    persistCache(cache);
    eventBus.emit("catalog:cache:cleared", { ts: clock.now() });
  }

  // ---- CONCURRENCY / RETRY ---------------------------------------------------

  function setAdapterConcurrency(name, max = 2) {
    const bucket = queues.get(name) || { max: 2, q: [] };
    bucket.max = Math.max(1, Number(max));
    queues.set(name, bucket);
  }

  async function withAdapterConcurrency(name, task) {
    const bucket = queues.get(name) || { max: 2, q: [] };
    queues.set(name, bucket);

    if (bucket.q.length >= bucket.max) {
      await new Promise((resolve) => bucket.q.push(resolve));
    }
    let releaser;
    const release = () => {
      if (releaser) return;
      releaser = bucket.q.shift();
      releaser?.();
    };
    try {
      return await task();
    } finally {
      release();
    }
  }

  async function withRetry(fn, { maxAttempts = 3, baseDelayMs = 300, rateLimitDelayMs = 2000 } = {}) {
    let attempt = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        attempt += 1;
        return await fn();
      } catch (e) {
        if (attempt >= maxAttempts) throw e;
        const is429 = (e && (e.status === 429 || /429/.test(String(e.message || ""))));
        const delay = is429 ? rateLimitDelayMs : Math.round(baseDelayMs * Math.pow(1.8, attempt - 1));
        await sleep(delay);
      }
    }
  }

  // ---- NORMALIZATION ---------------------------------------------------------

  function safeNormalizeOffer(storeId) {
    return (o = {}) => {
      const price = o.price || {};
      const store = o.store || {};
      const unit = o.unit ? {
        qty: Number(o.unit.qty || 0) || undefined,
        uom: typeof o.unit.uom === "string" ? o.unit.uom : undefined,
        packCount: Number(o.unit.packCount || 0) || undefined,
      } : undefined;

      return {
        id: String(o.id || `${storeId}:${Math.random().toString(36).slice(2)}`),
        title: String(o.title || "").trim(),
        store: {
          id: String(store.id || storeId),
          name: String(store.name || capitalize(storeId)),
          loyaltyTier: store.loyaltyTier || null,
          distanceKm: Number(store.distanceKm || 0) || undefined,
        },
        price: {
          amount: Number(price.amount || 0),
          currency: price.currency || "USD",
          includesTax: !!price.includesTax,
          taxRate: Number(price.taxRate || 0) || undefined,
        },
        sizeText: o.sizeText || undefined,
        unit,
        category: o.category || undefined,
        availability: o.availability || "in_stock",
        metadata: o.metadata || undefined,
      };
    };
  }

  // ---- MATERIALIZERS / PERSISTENCE ------------------------------------------

  function materializeAdapter(a) {
    return {
      name: a.name,
      displayName: a.displayName || capitalize(a.name),
      supports: a.supports || (() => true),
      lookupByBarcode: a.lookupByBarcode || (async () => []),
      lookupByQuery: a.lookupByQuery || (async () => []),
      ttlMs: Number(a.ttlMs || 5 * 60 * 1000),
      concurrency: Number(a.concurrency || 2),
      rateLimitDelayMs: Number(a.rateLimitDelayMs || 2500),
    };
  }

  function hydrateCache() {
    return prefs.get(CACHE_KEY) || {};
  }
  function persistCache(c) {
    try { prefs.set(CACHE_KEY, c); } catch (e) { console.warn("[CatalogHub] persist cache failed", e); }
  }

  function materializeProfile(p) {
    const curatedStores = config.get?.("catalog.curatedStores", []);
    const known = curatedStores.map((s) => s.id || s);
    const input = (p?.storeIds || []).filter(Boolean);
    const valid = input.length ? input.filter((s) => known.includes(s) || adapters.has(s)) : defaultStores();
    return {
      id: p?.id || `catalog:profile:${Date.now()}`,
      label: p?.label || "Household Store Catalog",
      storeIds: valid,
      zipcode: p?.zipcode || "",
      radiusKm: Number(p?.radiusKm || 25),
      refreshCadence: p?.refreshCadence || "off", // "off"|"hourly"|"daily"|"weekly"
    };
  }
  function defaultStores() {
    // Use configured defaults, else all registered adapters
    const cfg = config.get?.("catalog.defaultStores", null);
    if (Array.isArray(cfg) && cfg.length) return cfg;
    return Array.from(adapters.keys());
  }
  function hydrateProfile() {
    const stored = prefs.get(PROFILE_KEY);
    if (stored) return materializeProfile(stored);
    const p = materializeProfile({});
    persistProfile(p);
    return p;
  }
  function persistProfile(p) {
    try { prefs.set(PROFILE_KEY, p); } catch (e) { console.warn("[CatalogHub] persist profile failed", e); }
  }

  function hydrateFavorites() { return prefs.get(FAVORITES_KEY) || []; }
  function persistFavorites(arr) { try { prefs.set(FAVORITES_KEY, arr); } catch (e) { console.warn("[CatalogHub] persist favs failed", e); } }

  // ---- HELPERS ---------------------------------------------------------------

  function presentAdapter(a) {
    return { name: a.name, displayName: a.displayName, ttlMs: a.ttlMs, concurrency: a.concurrency };
  }

  function toErr(e) {
    return { message: String(e?.message || e), status: e?.status || null, code: e?.code || null };
  }

  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
  function capitalize(s) { return String(s || "").charAt(0).toUpperCase() + String(s || "").slice(1); }

  async function lazyImport(path) {
    try { return await import(/* @vite-ignore */ path); }
    catch (_) { return {}; }
  }

  // ---- SAFE ADAPTERS ---------------------------------------------------------

  function safeFetch() {
    return async (url, opts) => {
      // Browser fetch passthrough; on server, inject a polyfill
      return fetch(url, opts);
    };
  }
  function safeBus() { return { emit: () => {}, on: () => () => {} }; }
  function safeAnalytics() { return { track: () => {} }; }
  function safePrefs() {
    let mem = {};
    let ok = false;
    try { localStorage.setItem("__catalog_probe", "1"); localStorage.removeItem("__catalog_probe"); ok = true; } catch (_) {}
    return {
      get(k) { if (ok) { const raw = localStorage.getItem(k); return raw ? JSON.parse(raw) : null; } return mem[k] || null; },
      set(k, v) { if (ok) localStorage.setItem(k, JSON.stringify(v)); else mem[k] = v; },
    };
  }
}

// --------- Singleton convenience ---------------------------------------------
let __catalogHubSingleton;
export function getStoreCatalogHubSingleton(deps) {
  if (!__catalogHubSingleton) __catalogHubSingleton = createStoreCatalogHub(deps);
  return __catalogHubSingleton;
}

/* -------------------------------------------------------------------------- */
/* Example adapters (templates) — keep in this file or split per store.       */
/* Replace endpoints with your proxy/service calls as needed.                 */
/* -------------------------------------------------------------------------- */

export const ExampleJSONAdapter = {
  name: "example-json",
  displayName: "Example JSON Store",
  ttlMs: 3 * 60 * 1000,
  concurrency: 3,
  supports: ({ type }) => type === "query" || type === "barcode",

  // Pretend endpoint: GET /api/store/search?q=...&zip=...&radius=...
  async lookupByQuery(query, ctx) {
    const url = `/api/store/example/search?q=${encodeURIComponent(query)}&zip=${ctx.zipcode || ""}&r=${ctx.radiusKm || 25}`;
    const res = await ctx.fetcher(url, { method: "GET" });
    if (!res.ok) throw Object.assign(new Error("HTTP "+res.status), { status: res.status });
    const data = await res.json();

    // map to normalized offers
    return (data.items || []).map((it) => ({
      id: it.sku,
      title: it.title,
      store: { id: "example-json", name: "Example JSON", loyaltyTier: it.member ? "member" : "none" },
      price: { amount: it.price, currency: it.currency || "USD", includesTax: !!it.taxIn },
      sizeText: it.sizeText,
      unit: it.unit,
      category: it.category,
      availability: it.stock > 0 ? "in_stock" : "oos",
      metadata: { raw: it },
    }));
  },

  // Pretend endpoint: GET /api/store/item?barcode=...
  async lookupByBarcode(barcode, ctx) {
    const url = `/api/store/example/item?barcode=${encodeURIComponent(barcode)}&zip=${ctx.zipcode || ""}`;
    const res = await ctx.fetcher(url, { method: "GET" });
    if (!res.ok) throw Object.assign(new Error("HTTP "+res.status), { status: res.status });
    const it = await res.json();
    if (!it || !it.sku) return [];
    return [{
      id: it.sku,
      title: it.title,
      store: { id: "example-json", name: "Example JSON", loyaltyTier: it.member ? "member" : "none" },
      price: { amount: it.price, currency: it.currency || "USD", includesTax: !!it.taxIn },
      sizeText: it.sizeText,
      unit: it.unit,
      category: it.category,
      availability: it.stock > 0 ? "in_stock" : "oos",
      metadata: { raw: it },
    }];
  },
};

/**
 * Template for a REST/HTML-scrape proxy adapter (server-side proxy recommended).
 * Replace `/api/proxy/...` with your own endpoint that returns { items: [...] }.
 */
export const HtmlProxyAdapter = {
  name: "html-proxy",
  displayName: "HTML Proxy Store",
  ttlMs: 2 * 60 * 1000,
  concurrency: 2,
  supports: ({ type }) => type === "query",

  async lookupByQuery(query, ctx) {
    const url = `/api/proxy/search?store=html-proxy&q=${encodeURIComponent(query)}&zip=${ctx.zipcode || ""}`;
    const res = await ctx.fetcher(url, { method: "GET" });
    if (res.status === 429) throw Object.assign(new Error("429 rate limited"), { status: 429 });
    if (!res.ok) throw Object.assign(new Error("HTTP "+res.status), { status: res.status });
    const data = await res.json();
    return (data.items || []).map((x) => ({
      id: x.id,
      title: x.title,
      store: { id: "html-proxy", name: "HTML Proxy", loyaltyTier: x.member ? "member" : "none" },
      price: { amount: x.amount, currency: x.currency || "USD" },
      sizeText: x.size,
      availability: x.oos ? "oos" : "in_stock",
      metadata: { raw: x },
    }));
  },
};
