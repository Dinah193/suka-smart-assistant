/* eslint-disable no-console */
// src/features/scan-compare-trust/services/coupons/providers/CouponsComProvider.js
// Digital manufacturer coupons provider (Coupons.com–style).
// Style: ES2015-safe, DI-first, browser/node friendly, zero external deps here.

/**
 * createCouponsComProvider(deps)
 * -----------------------------------------------------------------------------
 * DI (all optional, safe defaults):
 *  - http:   { get(url,opts), post(url,body,opts) }  // must return {status, data}
 *  - clock:  { now(): Date }
 *  - eventBus:{ emit(evt,payload):void, on?(evt,fn):void }
 *  - analytics:{ track(evt,payload):void }
 *  - tokenStore:{
 *      get(): Promise<{accessToken, refreshToken, expiresAtISO} | null>,
 *      save(tok): Promise<void>,
 *      clear(): Promise<void>
 *    }
 *  - prefs: { sabbathGuard?, quietHours?, get(path,fb) } // schedule guard
 *  - db: Dexie-like (optional) with table('coupon_cache') for local cache
 *  - normalizers: instance from createCouponNormalizers(...)
 *  - favorites:  { getWatchlist():Promise<WatchKey[]>, upsertWatch(key,obj):Promise<void> }
 *
 * Public API:
 *  - list({pageSize, maxPages, forceRefresh}?) -> Promise<CanonicalCoupon[]>
 *  - syncAndRank() -> Promise<CanonicalCoupon[]>    // pulls, normalizes, dedupes, favorites flag
 *  - clip(couponId, {loyaltyId, storeId}) -> Promise<{ok:boolean, status:string}>
 *  - linkLoyalty({retailer, loyaltyId}) -> Promise<{ok:boolean}>
 *  - getStatus() -> lightweight provider diagnostics
 *
 * Emits:
 *  - 'coupon:provider:fetch:start' | ':success' | ':error'
 *  - 'coupon:normalized' (already emitted by Normalizers)
 *  - 'coupon:provider:clip:success' | ':error'
 *  - 'coupon:provider:loyalty:linked'
 */

export function createCouponsComProvider(deps = {}) {
  const http = deps.http || {
    async get() { return { status: 501, data: null }; },
    async post() { return { status: 501, data: null }; },
  };
  const clock = deps.clock || { now: () => new Date() };
  const eventBus = deps.eventBus || { emit: () => {} };
  const analytics = deps.analytics || { track: () => {} };
  const tokenStore = deps.tokenStore || {
    async get() { return null; },
    async save() {},
    async clear() {},
  };
  const prefs = deps.prefs || {
    get: () => undefined,
    sabbathGuard: { enabled: false, start: "Friday 17:00", end: "Saturday 21:00" },
    quietHours: { start: 21, end: 7 },
  };
  const db = deps.db || null;
  const normalizers = deps.normalizers || null;
  const favorites = deps.favorites || {
    async getWatchlist() { return []; },
    async upsertWatch() {},
  };

  // ---------------------------- internals -----------------------------------

  const iso = (d) => (d instanceof Date ? d.toISOString() : new Date(d).toISOString());
  const asDate = (x) => (x instanceof Date ? x : new Date(x));

  function withinQuietHours(now = clock.now()) {
    const qh = (prefs.quietHours && (prefs.quietHours.value || prefs.quietHours)) || { start: 21, end: 7 };
    const h = asDate(now).getHours();
    if (qh.start < qh.end) return h >= qh.start && h < qh.end;
    return h >= qh.start || h < qh.end; // overnight window
  }
  function sabbathActive(now = clock.now()) {
    const g = prefs.sabbathGuard?.enabled ? prefs.sabbathGuard : { enabled: false };
    if (!g.enabled) return false;
    const day = asDate(now).getDay(); // Fri/Sat
    return day === 5 || day === 6;
  }
  function scheduleAllowed(now = clock.now()) {
    return !withinQuietHours(now) && !sabbathActive(now);
  }

  // simple token bucket (burst 4, 1 req/sec thereafter)
  const rate = { capacity: 4, tokens: 4, refillMs: 1000, last: Date.now() };
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

  // OAuth-like helper (DI: use your real endpoints via env)
  const endpoints = {
    base: deps.baseUrl || 'https://api.coupons.example',  // placeholder
    list: '/v1/offers',
    clip: '/v1/clip',
    link: '/v1/loyalty/link',
    token: '/oauth/token',
  };

  async function getAccessToken() {
    const existing = await tokenStore.get();
    const now = clock.now();
    if (existing && existing.expiresAtISO && asDate(existing.expiresAtISO) > now) {
      return existing.accessToken;
    }
    // refresh or client_cred (DI keys via env)
    const payload = deps.auth?.refreshToken && existing?.refreshToken
      ? { grant_type: 'refresh_token', refresh_token: existing.refreshToken, client_id: deps.auth.clientId, client_secret: deps.auth.clientSecret }
      : { grant_type: 'client_credentials', client_id: deps.auth?.clientId || 'demo', client_secret: deps.auth?.clientSecret || 'demo' };
    const res = await http.post(endpoints.base + endpoints.token, payload, { headers: { 'Content-Type': 'application/json' } });
    if (res.status >= 200 && res.status < 300 && res.data?.access_token) {
      const expiresIn = Number(res.data.expires_in || 3600);
      const exp = new Date(clock.now().getTime() + expiresIn * 1000 - 30 * 1000);
      const tok = {
        accessToken: res.data.access_token,
        refreshToken: res.data.refresh_token || existing?.refreshToken || null,
        expiresAtISO: iso(exp),
      };
      await tokenStore.save(tok);
      return tok.accessToken;
    }
    // hard reset on failure
    await tokenStore.clear().catch(() => {});
    throw new Error('OAuth token fetch failed');
  }

  async function cachedGetCacheKey(page, pageSize) {
    return `couponscom::page=${page}::size=${pageSize}`;
  }

  async function cachePut(key, rows) {
    if (!db?.table) return;
    try {
      await db.table('coupon_cache').put({ id: key, rows, updatedAtISO: iso(clock.now()) });
    } catch (e) { console.warn('[CouponsCom] cachePut failed', e); }
  }
  async function cacheGet(key, maxAgeMs = 15 * 60 * 1000) {
    if (!db?.table) return null;
    try {
      const r = await db.table('coupon_cache').get(key);
      if (!r) return null;
      const age = Date.now() - asDate(r.updatedAtISO).getTime();
      if (age <= maxAgeMs) return r.rows || null;
      return null;
    } catch { return null; }
  }

  // ---------------------------- core fetch -----------------------------------

  async function fetchPage({ page = 1, pageSize = 50, forceRefresh = false } = {}) {
    const cacheKey = await cachedGetCacheKey(page, pageSize);
    if (!forceRefresh) {
      const cached = await cacheGet(cacheKey);
      if (cached) return cached;
    }

    await takeToken();
    const token = await getAccessToken();

    const url = new URL(endpoints.base + endpoints.list);
    url.searchParams.set('page', String(page));
    url.searchParams.set('pageSize', String(pageSize));
    // typical manufacturer filters:
    url.searchParams.set('type', 'manufacturer');
    url.searchParams.set('channel', 'online,app,instore');

    eventBus.emit('coupon:provider:fetch:start', { provider: 'couponscom', page });
    const res = await http.get(url.toString(), {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!(res.status >= 200 && res.status < 300) || !Array.isArray(res.data?.offers)) {
      eventBus.emit('coupon:provider:fetch:error', { provider: 'couponscom', page, status: res.status });
      throw new Error('Coupons API failed');
    }

    const rows = res.data.offers.map(remapRawOffer);
    await cachePut(cacheKey, rows);
    eventBus.emit('coupon:provider:fetch:success', { provider: 'couponscom', page, count: rows.length });

    return rows;
  }

  // shape → lightweight normalized “raw” for the Normalizers’ provider=storeAPI/affiliate/etc.
  function remapRawOffer(o) {
    // This maps a typical Coupons.com JSON to the Normalizers fallback fields.
    return {
      id: o.id || o.offerId,
      provider: 'couponscom',
      storeId: o.retailerId || 'manufacturer',          // manufacturer coupons can map to brand-level; storeId optional
      storeName: o.retailerName || 'Manufacturer',
      brandId: o.brandId || (o.brandName ? o.brandName.toLowerCase().replace(/\s+/g, '-') : null),
      brandName: o.brandName || null,
      sku: o.sku || null,
      upc: o.upc || null,
      gtin: o.gtin || null,
      title: o.title || o.headline || '',
      size: o.size || null,
      unit: o.unit || null,
      categoryPath: o.categoryPath || o.category ? [o.category] : [],
      // Offer fields
      percentOff: o.percentOff || null,
      amountOff: o.amountOff || null,           // "$1.50"
      priceDrop: o.priceDrop || null,
      minQty: o.minQty || o.purchaseQty || null,
      minSpend: o.minSpend || null,
      buyQty: o.buyQty || null,
      getQty: o.getQty || null,
      getPct: o.getPct || null,
      loyaltyRequired: !!o.loyaltyRequired,
      manufacturer: true,                        // mark as manufacturer coupon
      newCustomerOnly: !!o.newCustomerOnly,
      // Windows
      startDate: o.startDate || o.validFrom || o.start,
      endDate: o.endDate || o.validTo || o.expiration,
      // Limits & legal
      limitPerTxn: o.limitPerTransaction || null,
      limitPerCustomer: o.limitPerCustomer || null,
      limitPerDay: o.limitPerDay || null,
      exclusions: o.exclusions || [],
      termsText: o.terms || null,
      images: o.images || o.thumbnails || [],
      // Pricing hints (not always provided)
      listPrice: o.msrp || null,
      salePrice: o.salePrice || null,
      // Meta (for SourceAttribution)
      meta: {
        provider: 'couponscom',
        raw: { id: o.id, retailerId: o.retailerId, brandId: o.brandId },
      },
    };
  }

  // ------------------------- normalize / dedupe / rank -----------------------

  async function list({ pageSize = 50, maxPages = 2, forceRefresh = false } = {}) {
    if (!normalizers) throw new Error('Normalizers instance required');
    const now = clock.now();
    if (!scheduleAllowed(now)) {
      // return warm cache quickly when schedule blocked
      const firstKey = await cachedGetCacheKey(1, pageSize);
      const cached = await cacheGet(firstKey, 60 * 60 * 1000 /* up to 1h */);
      const asNormalized = cached ? await normalizers.normalizeBatch(cached, 'storeAPI') : [];
      return normalizers.dedupeAndRank(asNormalized);
    }

    const pages = [];
    for (let p = 1; p <= Math.max(1, maxPages); p++) {
      try {
        const raw = await fetchPage({ page: p, pageSize, forceRefresh });
        pages.push(...raw);
      } catch (e) {
        console.warn('[CouponsCom] page fetch failed', p, e?.message);
        break;
      }
    }

    const normalized = await normalizers.normalizeBatch(pages, 'storeAPI');
    const ranked = normalizers.dedupeAndRank(normalized);
    const withFavs = await normalizers.flagFavorites(ranked);
    analytics.track('coupon_provider_listed', { provider: 'couponscom', count: withFavs.length });
    return withFavs;
  }

  async function syncAndRank() {
    const coupons = await list({ pageSize: 100, maxPages: 3, forceRefresh: false });
    eventBus.emit('coupon:provider:sync', { provider: 'couponscom', count: coupons.length });
    return coupons;
  }

  // ------------------------------- clip / loyalty ----------------------------

  async function linkLoyalty({ retailer, loyaltyId }) {
    await takeToken();
    const token = await getAccessToken();
    const res = await http.post(endpoints.base + endpoints.link, { retailer, loyaltyId }, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });
    if (res.status >= 200 && res.status < 300) {
      eventBus.emit('coupon:provider:loyalty:linked', { provider: 'couponscom', retailer });
      analytics.track('coupon_loyalty_linked', { provider: 'couponscom', retailer });
      return { ok: true };
    }
    return { ok: false, status: String(res.status || 'error') };
  }

  async function clip(couponId, { loyaltyId, storeId } = {}) {
    await takeToken();
    const token = await getAccessToken();

    const body = { couponId, loyaltyId, storeId };
    const res = await http.post(endpoints.base + endpoints.clip, body, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });

    if (res.status >= 200 && res.status < 300 && res.data?.status === 'clipped') {
      eventBus.emit('coupon:provider:clip:success', { provider: 'couponscom', couponId, storeId });
      analytics.track('coupon_clip_success', { provider: 'couponscom', couponId, storeId });
      return { ok: true, status: 'clipped' };
    }
    eventBus.emit('coupon:provider:clip:error', { provider: 'couponscom', couponId, status: res.status });
    return { ok: false, status: String(res.status || 'error') };
  }

  // ------------------------------- status ------------------------------------

  async function getStatus() {
    const token = await tokenStore.get();
    return {
      provider: 'couponscom',
      tokenValid: !!(token?.accessToken && token?.expiresAtISO && asDate(token.expiresAtISO) > clock.now()),
      nextRefreshISO: token?.expiresAtISO || null,
      scheduleAllowed: scheduleAllowed(),
    };
  }

  // ---------------------------- favorites glue -------------------------------

  async function upsertFavoriteFromCoupon(c) {
    if (!c?.watchKey || !favorites?.upsertWatch) return;
    await favorites.upsertWatch(c.watchKey, { notify: true, minPct: 10, channels: ['toast'] });
  }

  // ------------------------------- API ---------------------------------------

  return {
    list,
    syncAndRank,
    clip,
    linkLoyalty,
    getStatus,
    // optional helper: star a coupon’s cadence key
    upsertFavoriteFromCoupon,
  };
}

/* -----------------------------------------------------------------------------
USAGE NOTES (wire-up hints; no imports here)

// 1) Instantiate in your Coupons service composition root:
import { createCouponNormalizers } from '../Normalizers.js';
import { createCouponsComProvider } from './providers/CouponsComProvider.js';

const normalizers = createCouponNormalizers({ clock, eventBus, analytics, sourceAttribution, favorites });
const couponsCom = createCouponsComProvider({
  http, clock, eventBus, analytics, tokenStore, prefs, db, normalizers, favorites,
  baseUrl: import.meta.env.VITE_COUPONS_BASE_URL,
  auth: {
    clientId: import.meta.env.VITE_COUPONS_CLIENT_ID,
    clientSecret: import.meta.env.VITE_COUPONS_CLIENT_SECRET,
    refreshToken: null // if your flow uses it
  }
});

// 2) Pull, normalize, dedupe, favorites flag:
const coupons = await couponsCom.syncAndRank();

// 3) Let users star/favorite sessions/schedules:
await couponsCom.upsertFavoriteFromCoupon(coupons[0]); // or show a star button using coupon.watchKey

// 4) Clip to loyalty card (when supported):
await couponsCom.linkLoyalty({ retailer: 'kroger', loyaltyId: 'ABC12345' });
await couponsCom.clip(coupons[0].id, { loyaltyId: 'ABC12345', storeId: coupons[0].store.id });

// 5) Orchestrator glue (typical):
// - Normalizers already emit 'coupon:normalized' → your CycleAnalyzer listens to learn cadence.
// - You can also forward ranked coupons to Pricing UI + SourceAttribution panel.

// 6) Dexie hint (optional cache):
// db.version(1).stores({ coupon_cache: 'id, updatedAtISO' });

----------------------------------------------------------------------------- */
