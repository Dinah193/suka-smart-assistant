/* eslint-disable no-console */
// src/features/scan-compare-trust/services/coupons/providers/StoreWeeklyAdProvider.js
// Weekly circulars aggregator (e.g., H-E-B, Kroger, Publix, Safeway, Walmart regional).
// Style: ESM, DI-first, registry of per-store adapters, zero external deps here.

export function createStoreWeeklyAdProvider(deps = {}) {
  // ---------- DI (safe defaults) --------------------------------------------
  const http = deps.http || {
    async get() { return { status: 501, data: null }; },
    async post() { return { status: 501, data: null }; },
  };
  const clock = deps.clock || { now: () => new Date() };
  const eventBus = deps.eventBus || { emit: () => {}, on: () => {} };
  const analytics = deps.analytics || { track: () => {} };
  const prefs = deps.prefs || {
    get: () => undefined,
    sabbathGuard: { enabled: false, start: "Friday 17:00", end: "Saturday 21:00" },
    quietHours: { start: 21, end: 7 },
  };
  const db = deps.db || null;                     // Dexie-like (optional cache)
  const normalizers = deps.normalizers || null;   // createCouponNormalizers(...)
  const favorites = deps.favorites || {
    async getWatchlist() { return []; },
    async upsertWatch() {},
  };
  const sourceAttribution = deps.sourceAttribution || { attach: () => [] };
  const cycleAnalyzer = deps.cycleAnalyzer || null; // optional: createCycleAnalyzer(...)

  // ---------- Guards & utils -------------------------------------------------
  const asDate = (x) => (x instanceof Date ? x : new Date(x));
  const iso = (d) => (d instanceof Date ? d.toISOString() : new Date(d).toISOString());
  const dayDiff = (a, b) => Math.ceil(Math.abs(asDate(a) - asDate(b)) / 86400000);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  function withinQuietHours(now = clock.now()) {
    const qh = (prefs.quietHours && (prefs.quietHours.value || prefs.quietHours)) || { start: 21, end: 7 };
    const h = asDate(now).getHours();
    if (qh.start < qh.end) return h >= qh.start && h < qh.end;
    return h >= qh.start || h < qh.end; // overnight window
  }
  function sabbathActive(now = clock.now()) {
    const g = prefs.sabbathGuard?.enabled ? prefs.sabbathGuard : { enabled: false };
    if (!g.enabled) return false;
    const d = asDate(now).getDay();
    return d === 5 || d === 6; // Fri/Sat heuristic; refine with your scheduler if needed
  }
  function scheduleAllowed(now = clock.now()) {
    return !withinQuietHours(now) && !sabbathActive(now);
  }

  // small token bucket (burst 6, ~2 rps)
  const rate = { capacity: 6, tokens: 6, refillMs: 500, last: Date.now() };
  async function takeToken() {
    const now = Date.now();
    const elapsed = now - rate.last;
    if (elapsed > rate.refillMs) {
      const refill = Math.floor(elapsed / rate.refillMs);
      rate.tokens = Math.min(rate.capacity, rate.tokens + refill);
      rate.last = now;
    }
    if (rate.tokens > 0) { rate.tokens -= 1; return; }
    await new Promise((r) => setTimeout(r, rate.refillMs));
  }

  // ---------- Cache (Dexie optional) -----------------------------------------
  async function cachePut(id, rows) {
    if (!db?.table) return;
    try { await db.table('coupon_cache').put({ id, rows, updatedAtISO: iso(clock.now()) }); }
    catch (e) { console.warn('[WeeklyAd] cachePut failed', e); }
  }
  async function cacheGet(id, maxAgeMs = 10 * 60 * 1000) {
    if (!db?.table) return null;
    try {
      const r = await db.table('coupon_cache').get(id);
      if (!r) return null;
      const age = Date.now() - asDate(r.updatedAtISO).getTime();
      return age <= maxAgeMs ? (r.rows || null) : null;
    } catch { return null; }
  }

  // ---------- Adapter registry ------------------------------------------------
  /**
   * Adapter contracts (all return plain JS objects):
   *
   * adapter.id(): string                        // e.g., 'heb', 'kroger'
   * adapter.canHandle({ storeId }): boolean
   * adapter.fetchIndex(ctx, { zip?, storeId?, page?, pageSize? }): Promise<{items: RawAdItem[], nextPage?:number|null}>
   *   RawAdItem minimal fields (free-form extras allowed):
   *   {
   *     id, title, brandName?, brandId?, upc?, sku?, categoryPath?,
   *     storeId, storeName?, region?, price?, listPrice?, unit?, size?,
   *     percentOff?, amountOff?, startDate?, endDate?,
   *     tags?:[], images?:[], terms?:string, exclusions?:[],
   *   }
   */
  const adapters = new Map();
  function registerAdapter(adapter) {
    if (!adapter || typeof adapter.id !== 'function') {
      throw new Error('Adapter must implement id()');
    }
    adapters.set(adapter.id(), adapter);
    return api; // chainable
  }
  function getAdapterFor(storeId) {
    for (const ad of adapters.values()) {
      try { if (ad.canHandle?.({ storeId })) return ad; } catch {}
    }
    return null;
  }
  function listRegistered() {
    return Array.from(adapters.keys());
  }

  // ---------- Raw→Normalizer remap -------------------------------------------
  function remapAdToNormalizerRaw(ad) {
    // Weekly ad “price drops” map well to Normalizers fallback shape.
    return {
      id: ad.id,
      provider: 'weeklyad',
      storeId: ad.storeId,
      storeName: ad.storeName,
      brandId: ad.brandId || (ad.brandName ? ad.brandName.toLowerCase().replace(/\s+/g, '-') : null),
      brandName: ad.brandName || null,
      sku: ad.sku || null,
      upc: ad.upc || null,
      gtin: ad.gtin || null,
      title: ad.title || '',
      size: ad.size || null,
      unit: ad.unit || null,
      categoryPath: Array.isArray(ad.categoryPath) ? ad.categoryPath : (ad.categoryPath ? [ad.categoryPath] : []),

      // Offer-like fields understood by Normalizers fallback:
      percentOff: ad.percentOff ?? null,
      amountOff: ad.amountOff ?? null,      // "$1.00"
      priceDrop: ad.priceDrop ?? null,      // "$3.99" if ad calls out sale price
      minQty: ad.minQty ?? null,
      minSpend: ad.minSpend ?? null,
      buyQty: ad.buyQty ?? null,
      getQty: ad.getQty ?? null,
      getPct: ad.getPct ?? null,
      loyaltyRequired: !!ad.loyaltyRequired,
      manufacturer: false,
      newCustomerOnly: !!ad.newCustomerOnly,

      // Dates
      startDate: ad.startDate,
      endDate: ad.endDate,

      // Limits & legal
      limitPerTxn: ad.limitPerTxn ?? null,
      limitPerCustomer: ad.limitPerCustomer ?? null,
      limitPerDay: ad.limitPerDay ?? null,
      exclusions: ad.exclusions || [],
      termsText: ad.terms || null,

      images: ad.images || [],
      listPrice: ad.listPrice ?? null,
      salePrice: ad.price ?? ad.salePrice ?? null,

      meta: {
        provider: 'weeklyad',
        adapter: ad.adapterId || null,
        raw: { id: ad.id, storeId: ad.storeId, region: ad.region || null },
      },
    };
  }

  // ---------- Core listing ----------------------------------------------------
  async function list({ storeId, zip = null, pageSize = 120, maxPages = 2, forceRefresh = false } = {}) {
    if (!storeId) throw new Error('storeId required');
    if (!normalizers) throw new Error('Normalizers instance required');

    const adapter = getAdapterFor(storeId);
    if (!adapter) {
      console.warn('[WeeklyAd] No adapter registered for storeId:', storeId);
      return [];
    }

    // schedule guard: if blocked, prefer cache
    if (!scheduleAllowed()) {
      const cacheKey = `weeklyad::${adapter.id()}::${storeId}::zip=${zip || 'na'}::p=1::s=${pageSize}`;
      const cached = await cacheGet(cacheKey, 60 * 60 * 1000);
      const normalized = cached ? await normalizers.normalizeBatch(cached.map(remapAdToNormalizerRaw), 'storeAPI') : [];
      const ranked = normalizers.dedupeAndRank(normalized);
      return normalizers.flagFavorites(ranked);
    }

    const all = [];
    let page = 1;
    for (; page <= Math.max(1, maxPages); page++) {
      const cacheKey = `weeklyad::${adapter.id()}::${storeId}::zip=${zip || 'na'}::p=${page}::s=${pageSize}`;
      if (!forceRefresh) {
        const cached = await cacheGet(cacheKey);
        if (cached) {
          all.push(...cached);
          continue;
        }
      }

      await takeToken();
      eventBus.emit('coupon:provider:fetch:start', { provider: 'weeklyad', adapter: adapter.id(), storeId, page });

      let res;
      try {
        res = await adapter.fetchIndex(
          { http, clock, eventBus, analytics, sourceAttribution },
          { storeId, zip, page, pageSize }
        );
      } catch (e) {
        console.warn('[WeeklyAd] fetchIndex failed', adapter.id(), e?.message);
        eventBus.emit('coupon:provider:fetch:error', { provider: 'weeklyad', adapter: adapter.id(), storeId, page, error: e?.message });
        break;
      }

      const items = Array.isArray(res?.items) ? res.items : [];
      items.forEach(i => (i.adapterId = adapter.id()));
      await cachePut(cacheKey, items);
      all.push(...items);

      eventBus.emit('coupon:provider:fetch:success', { provider: 'weeklyad', adapter: adapter.id(), storeId, page, count: items.length });
      if (!res?.nextPage) break;
    }

    // Normalize via Normalizers as 'storeAPI'
    const normalized = await normalizers.normalizeBatch(all.map(remapAdToNormalizerRaw), 'storeAPI');

    // Weekly ads are usually *priceDrop* offers; set consistent semantics & stackability
    normalized.forEach((c) => {
      c.offer.type = c.offer.type || 'priceDrop';
      // weekly ad drops usually stack with manufacturer coupons and sometimes loyalty
      c.offer.stackable = { withManufacturer: true, withStore: false, withLoyalty: true, withRebate: true, withPromoCode: true };
      if (!c.window?.startISO || !c.window?.endISO) {
        // typical weekly span: 7 days; if end missing, assume 6d from start/now
        const start = c.window?.startISO ? asDate(c.window.startISO) : clock.now();
        const end = new Date(start); end.setDate(end.getDate() + 6);
        c.window = { ...c.window, startISO: iso(start), endISO: iso(end), isActive: true, daysLeft: dayDiff(end, clock.now()) };
      }
    });

    // (Optional) feed observations to CycleAnalyzer so cadence learns from ad items
    if (cycleAnalyzer && typeof cycleAnalyzer.recordObservation === 'function') {
      try {
        for (const c of normalized) {
          cycleAnalyzer.recordObservation({
            ts: c.source?.fetchedAtISO || iso(clock.now()),
            storeId: c.store?.id,
            brandId: c.brand?.id,
            sku: c.product?.sku || c.product?.upc,
            listPrice: c.pricing?.listPrice ?? null,
            price: c.pricing?.salePrice ?? null,
            discountPct: c.pricing?.computed?.discountPct ?? null,
            couponId: c.id,
            couponType: c.offer?.type,
            stackable: !!c.offer?.stackable,
            loyaltyRequired: !!c.offer?.loyaltyRequired,
            provider: 'weeklyad',
            meta: { adapter: c.source?.adapter || c.meta?.adapter || adapter.id() },
          });
        }
      } catch (e) {
        console.warn('[WeeklyAd] cycleAnalyzer.recordObservation failed (non-fatal)', e?.message);
      }
    }

    const ranked = normalizers.dedupeAndRank(normalized);
    const withFavs = await normalizers.flagFavorites(ranked);

    analytics.track('weeklyad_listed', { adapter: adapter.id(), storeId, count: withFavs.length });
    eventBus.emit('coupon:provider:sync', { provider: 'weeklyad', adapter: adapter.id(), storeId, count: withFavs.length });

    return withFavs;
  }

  async function syncAndRankFor(storeId, opts = {}) {
    return list({ storeId, zip: opts.zip || null, pageSize: opts.pageSize || 150, maxPages: opts.maxPages || 2, forceRefresh: !!opts.forceRefresh });
  }

  // ---------- Helpers: best windows, calendar preview ------------------------
  function summarizeByCategory(coupons = []) {
    const map = new Map();
    for (const c of coupons) {
      const cat = (c.product?.categoryPath && c.product.categoryPath[0]) || 'Uncategorized';
      const prev = map.get(cat) || { count: 0, bestPct: 0, sample: null };
      const pct = c.pricing?.computed?.discountPct || 0;
      if (pct > prev.bestPct) { prev.bestPct = pct; prev.sample = c; }
      prev.count += 1;
      map.set(cat, prev);
    }
    return Array.from(map.entries())
      .map(([category, v]) => ({ category, count: v.count, bestPct: Math.round(v.bestPct * 100) / 100, sample: v.sample }))
      .sort((a, b) => b.bestPct - a.bestPct);
  }

  function getDealCalendar(coupons = [], horizonDays = 14) {
    const now = clock.now();
    const windows = coupons
      .map((c) => ({
        key: c.watchKey,
        startISO: c.window?.startISO,
        endISO: c.window?.endISO,
        isActive: c.window?.isActive,
      }))
      .filter((w) => w.startISO && dayDiff(w.startISO, now) <= horizonDays);
    return { windows, updatedAt: iso(now) };
  }

  // ---------- Favorites glue -------------------------------------------------
  async function upsertFavoriteFromCoupon(c, opts = {}) {
    if (!c?.watchKey || !favorites?.upsertWatch) return;
    await favorites.upsertWatch(c.watchKey, {
      notify: opts.notify !== false,
      minPct: opts.minPct ?? 8,
      channels: opts.channels || ['toast'],
      notes: `Watch weekly ad price drops for ${c.brand?.name || c.product?.title || 'item'} at ${c.store?.name || c.store?.id}`,
    });
    analytics.track('weeklyad_watch_upserted', { key: JSON.stringify(c.watchKey) });
  }

  // ---------- Example adapters (lightweight placeholders) --------------------
  // NOTE: Replace with real implementations in /providers/adapters/*.js and register them.

  const HEBAdapter = {
    id: () => 'heb',
    canHandle: ({ storeId }) => /(^heb$|^h-e-b$|^heb\-)/i.test(String(storeId || '')),
    async fetchIndex(ctx, { storeId, zip, page = 1, pageSize = 120 }) {
      // EXAMPLE shape; replace with your real API
      // Pretend endpoint: GET /weeklyad?store=heb&zip=xxxx&page=1&pageSize=120
      const url = new URL('https://weeklyad.example/heb');
      if (zip) url.searchParams.set('zip', zip);
      url.searchParams.set('page', String(page));
      url.searchParams.set('pageSize', String(pageSize));

      await takeToken();
      const res = await http.get(url.toString());
      if (!(res.status >= 200 && res.status < 300) || !Array.isArray(res.data?.items)) {
        return { items: [], nextPage: null };
      }
      const items = res.data.items.map((it) => ({
        id: it.id,
        title: it.title,
        brandName: it.brand,
        brandId: it.brand ? it.brand.toLowerCase().replace(/\s+/g, '-') : null,
        upc: it.upc,
        sku: it.sku,
        categoryPath: it.category ? [it.category] : [],
        storeId,
        storeName: 'H-E-B',
        region: zip || null,
        listPrice: it.listPrice ?? null,
        price: it.salePrice ?? it.price ?? null,
        unit: it.unit || null,
        size: it.size || null,
        percentOff: it.percentOff ?? null,
        amountOff: it.amountOff ?? null,
        startDate: it.startDate,
        endDate: it.endDate,
        terms: it.terms,
        exclusions: it.exclusions || [],
        images: it.images || [],
      }));
      return { items, nextPage: res.data.nextPage || null };
    },
  };

  const KrogerAdapter = {
    id: () => 'kroger',
    canHandle: ({ storeId }) => /kroger|fredmeyer|frys|smiths|kingsoopers|ralphs/i.test(String(storeId || '')),
    async fetchIndex(ctx, { storeId, zip, page = 1, pageSize = 120 }) {
      const url = new URL('https://weeklyad.example/kroger');
      if (zip) url.searchParams.set('zip', zip);
      url.searchParams.set('page', String(page));
      url.searchParams.set('pageSize', String(pageSize));

      await takeToken();
      const res = await http.get(url.toString());
      if (!(res.status >= 200 && res.status < 300) || !Array.isArray(res.data?.adItems)) {
        return { items: [], nextPage: null };
      }
      const items = res.data.adItems.map((it) => ({
        id: it.id,
        title: it.name || it.title,
        brandName: it.brandName,
        brandId: it.brandId,
        upc: it.upc,
        sku: it.sku,
        categoryPath: it.categoryPath || [],
        storeId,
        storeName: 'Kroger',
        region: zip || null,
        listPrice: it.regularPrice ?? null,
        price: it.salePrice ?? it.promoPrice ?? null,
        unit: it.unit || null,
        size: it.size || null,
        percentOff: it.percentOff ?? null,
        amountOff: it.amountOff ?? null,
        startDate: it.startDate,
        endDate: it.endDate,
        terms: it.terms,
        exclusions: it.exclusions || [],
        images: it.images || [],
        loyaltyRequired: !!it.withCard, // “with card” pricing
      }));
      return { items, nextPage: res.data.nextPage || null };
    },
  };

  // auto-register example adapters (safe to keep; replace or extend in app root)
  registerAdapter(HEBAdapter);
  registerAdapter(KrogerAdapter);

  // ---------- Public API -----------------------------------------------------
  const api = {
    // main
    list,
    syncAndRankFor,

    // helpers
    summarizeByCategory,
    getDealCalendar,
    upsertFavoriteFromCoupon,

    // registry
    registerAdapter,
    listRegistered,
  };

  return api;
}

/* -----------------------------------------------------------------------------
USAGE NOTES (wire-up; no imports here)

// 1) Compose in your Coupons service root:
import { createCouponNormalizers } from '../Normalizers.js';
import { createCycleAnalyzer } from '../CycleAnalyzer.js';
import { createStoreWeeklyAdProvider } from './providers/StoreWeeklyAdProvider.js';

const normalizers = createCouponNormalizers({ clock, eventBus, analytics, sourceAttribution, favorites });
const cycleAnalyzer = createCycleAnalyzer({ clock, eventBus, analytics, db, prefs, favorites, sourceAttribution });

const weeklyAd = createStoreWeeklyAdProvider({
  http, clock, eventBus, analytics, prefs, db, normalizers, favorites, sourceAttribution, cycleAnalyzer
});

// 2) Pull a store’s circular → normalized, ranked, favorites flagged:
const hebAd = await weeklyAd.syncAndRankFor('heb', { zip: '78704' });

// 3) Let users star *sessions/schedules* (store•brand•SKU) right from ad cards:
await weeklyAd.upsertFavoriteFromCoupon(hebAd[0], { minPct: 8 });

// 4) Show category summary or a compact “Deal Calendar” strip in UI:
const categories = weeklyAd.summarizeByCategory(hebAd);
const calendar = weeklyAd.getDealCalendar(hebAd, 14);

// 5) Add/override adapters in your app boot:
weeklyAd.registerAdapter({
  id: () => 'publix',
  canHandle: ({ storeId }) => /publix/i.test(storeId || ''),
  async fetchIndex(ctx, { storeId, zip, page = 1, pageSize = 120 }) {
    // fetch & map to RawAdItem[]
    return { items: [], nextPage: null };
  }
});

// 6) Orchestrator glue:
// - Normalizers emit 'coupon:normalized' → CycleAnalyzer learns.
// - This provider also optionally sends recordObservation() to CycleAnalyzer.
// - SourceAttribution.attach(meta) is called to populate your SourceAttribution panel.

// 7) Optional Dexie store reuse:
// db.version(1).stores({ coupon_cache: 'id, updatedAtISO' });

----------------------------------------------------------------------------- */
