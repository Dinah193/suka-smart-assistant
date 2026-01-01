/* eslint-disable no-console */
// src/features/scan-compare-trust/services/coupons/providers/RakutenProvider.js
// Cashback / affiliate provider (Rakuten-style).
// Style: ES2015-safe, DI-first, browser/node friendly, zero external deps here.

export function createRakutenProvider(deps = {}) {
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
  const db = deps.db || null; // Dexie-like optional cache
  const normalizers = deps.normalizers || null; // from createCouponNormalizers(...)
  const favorites = deps.favorites || {
    async getWatchlist() { return []; },
    async upsertWatch() {},
  };
  const sourceAttribution = deps.sourceAttribution || { attach: () => [] };

  // ----------- endpoints (DI via env) ---------------------------------------
  const endpoints = {
    base: deps.baseUrl || 'https://api.rakuten.example', // placeholder
    merchants: '/v1/merchants',
    offers: '/v1/offers',        // includes merchantId filter
    click: '/v1/click',          // return redirect/deeplink
    token: '/oauth/token',
  };

  const affiliateParams = {
    siteId: deps.siteId || (typeof import.meta !== 'undefined' ? import.meta.env?.VITE_AFFILIATE_SITE_ID : null) || 'demo-site',
    pid: deps.pid || (typeof import.meta !== 'undefined' ? import.meta.env?.VITE_AFFILIATE_PID : null) || 'demo-pid',
  };

  // ----------- guards & utils ----------------------------------------------
  const asDate = (x) => (x instanceof Date ? x : new Date(x));
  const iso = (d) => (d instanceof Date ? d.toISOString() : new Date(d).toISOString());

  function withinQuietHours(now = clock.now()) {
    const qh = (prefs.quietHours && (prefs.quietHours.value || prefs.quietHours)) || { start: 21, end: 7 };
    const h = asDate(now).getHours();
    if (qh.start < qh.end) return h >= qh.start && h < qh.end;
    return h >= qh.start || h < qh.end; // overnight window
  }
  function sabbathActive(now = clock.now()) {
    const g = prefs.sabbathGuard?.enabled ? prefs.sabbathGuard : { enabled: false };
    if (!g.enabled) return false;
    const day = asDate(now).getDay();
    return day === 5 || day === 6; // Fri/Sat heuristic
  }
  function scheduleAllowed(now = clock.now()) {
    return !withinQuietHours(now) && !sabbathActive(now);
  }

  // simple token bucket (burst 4, 1 rps after)
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

  async function getAccessToken() {
    const existing = await tokenStore.get();
    const now = clock.now();
    if (existing?.accessToken && existing?.expiresAtISO && asDate(existing.expiresAtISO) > now) {
      return existing.accessToken;
    }
    const body = deps.auth?.refreshToken && existing?.refreshToken
      ? { grant_type: 'refresh_token', refresh_token: existing.refreshToken, client_id: deps.auth.clientId, client_secret: deps.auth.clientSecret }
      : { grant_type: 'client_credentials', client_id: deps.auth?.clientId || 'demo', client_secret: deps.auth?.clientSecret || 'demo' };
    const res = await http.post(endpoints.base + endpoints.token, body, { headers: { 'Content-Type': 'application/json' } });
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
    await tokenStore.clear().catch(() => {});
    throw new Error('OAuth token fetch failed');
  }

  // ---------- cache helpers (Dexie) -----------------------------------------
  async function cachePut(id, rows) {
    if (!db?.table) return;
    try { await db.table('coupon_cache').put({ id, rows, updatedAtISO: iso(clock.now()) }); }
    catch (e) { console.warn('[Rakuten] cachePut failed', e); }
  }
  async function cacheGet(id, maxAgeMs = 15 * 60 * 1000) {
    if (!db?.table) return null;
    try {
      const r = await db.table('coupon_cache').get(id);
      if (!r) return null;
      const age = Date.now() - asDate(r.updatedAtISO).getTime();
      return age <= maxAgeMs ? (r.rows || null) : null;
    } catch { return null; }
  }

  // ---------- raw fetchers ---------------------------------------------------
  async function fetchMerchants({ page = 1, pageSize = 100, forceRefresh = false } = {}) {
    const cacheKey = `rakuten::merchants::p=${page}::s=${pageSize}`;
    if (!forceRefresh) {
      const cached = await cacheGet(cacheKey, 24 * 60 * 60 * 1000);
      if (cached) return cached;
    }

    await takeToken();
    const token = await getAccessToken();
    const url = new URL(endpoints.base + endpoints.merchants);
    url.searchParams.set('page', String(page));
    url.searchParams.set('pageSize', String(pageSize));

    eventBus.emit('coupon:provider:fetch:start', { provider: 'rakuten', page, type: 'merchants' });
    const res = await http.get(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
    if (!(res.status >= 200 && res.status < 300) || !Array.isArray(res.data?.merchants)) {
      eventBus.emit('coupon:provider:fetch:error', { provider: 'rakuten', page, type: 'merchants', status: res.status });
      throw new Error('Merchants API failed');
    }
    await cachePut(cacheKey, res.data.merchants);
    eventBus.emit('coupon:provider:fetch:success', { provider: 'rakuten', page, type: 'merchants', count: res.data.merchants.length });
    return res.data.merchants;
  }

  async function fetchOffers({ merchantId, page = 1, pageSize = 100, forceRefresh = false } = {}) {
    const cacheKey = `rakuten::offers::m=${merchantId || 'all'}::p=${page}::s=${pageSize}`;
    if (!forceRefresh) {
      const cached = await cacheGet(cacheKey);
      if (cached) return cached;
    }

    await takeToken();
    const token = await getAccessToken();
    const url = new URL(endpoints.base + endpoints.offers);
    if (merchantId) url.searchParams.set('merchantId', String(merchantId));
    url.searchParams.set('page', String(page));
    url.searchParams.set('pageSize', String(pageSize));

    eventBus.emit('coupon:provider:fetch:start', { provider: 'rakuten', page, type: 'offers', merchantId });
    const res = await http.get(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
    if (!(res.status >= 200 && res.status < 300) || !Array.isArray(res.data?.offers)) {
      eventBus.emit('coupon:provider:fetch:error', { provider: 'rakuten', page, type: 'offers', status: res.status, merchantId });
      throw new Error('Offers API failed');
    }
    await cachePut(cacheKey, res.data.offers);
    eventBus.emit('coupon:provider:fetch:success', { provider: 'rakuten', page, type: 'offers', count: res.data.offers.length, merchantId });
    return res.data.offers;
  }

  // ---------- remap to Normalizers input ------------------------------------
  function remapOfferToRaw(cashback) {
    // Rakuten-like cashback % for merchant/category, sometimes with coupon text.
    // Map to Normalizers 'affiliate' provider fields; treat as 'rebate' (percent).
    const pct = cashback.rate ?? cashback.percent ?? cashback.cashbackPercent ?? null;
    const merchantId = cashback.merchantId || cashback.storeId || null;
    const merchantName = cashback.merchantName || cashback.storeName || cashback.name || null;

    return {
      id: cashback.id || `${merchantId || 'm'}_${pct || '0'}_${cashback.category || 'all'}`,
      provider: 'rakuten',
      storeId: merchantId,
      storeName: merchantName,
      brandId: cashback.brandId || null,
      brandName: cashback.brandName || merchantName, // often merchant is the brand surface
      sku: null, // merchant-wide offer
      upc: null,
      gtin: null,
      title: cashback.title || `${pct || 0}% cashback`,
      size: null,
      unit: null,
      categoryPath: cashback.category ? [cashback.category] : [],
      // Offer-style fields
      percentOff: pct,          // % cashback (we'll map as rebate/percent)
      amountOff: null,
      priceDrop: null,
      minQty: null,
      minSpend: cashback.minPurchase || cashback.minSpend || null,
      buyQty: null,
      getQty: null,
      getPct: null,
      loyaltyRequired: false,   // generally no store loyalty required for affiliate click-through
      manufacturer: false,
      newCustomerOnly: !!cashback.newCustomerOnly,
      // Windows
      startDate: cashback.startDate || cashback.start || null,
      endDate: cashback.endDate || cashback.expiration || null,
      // Limits & legal
      limitPerTxn: null,
      limitPerCustomer: null,
      limitPerDay: null,
      exclusions: (cashback.exclusions || cashback.terms || cashback.notes || []).filter(Boolean),
      termsText: cashback.terms || null,
      images: cashback.images || [],
      listPrice: null,
      salePrice: null,
      meta: {
        provider: 'rakuten',
        raw: { id: cashback.id, merchantId, merchantName, category: cashback.category, rate: pct },
      },
    };
  }

  // ---------- list & normalize ----------------------------------------------
  async function list({ merchantId = null, pageSize = 100, maxPages = 2, forceRefresh = false } = {}) {
    if (!normalizers) throw new Error('Normalizers instance required');
    const now = clock.now();
    if (!scheduleAllowed(now)) {
      // fall back to cache quickly
      const key = `rakuten::offers::m=${merchantId || 'all'}::p=1::s=${pageSize}`;
      const cached = await cacheGet(key, 60 * 60 * 1000);
      const normalized = cached ? await normalizers.normalizeBatch(cached.map(remapOfferToRaw), 'affiliate') : [];
      const ranked = normalizers.dedupeAndRank(normalized);
      return normalizers.flagFavorites(ranked);
    }

    // Pull offers
    const pages = [];
    for (let p = 1; p <= Math.max(1, maxPages); p++) {
      try {
        const rawOffers = await fetchOffers({ merchantId, page: p, pageSize, forceRefresh });
        pages.push(...rawOffers);
      } catch (e) {
        console.warn('[Rakuten] fetchOffers failed', p, e?.message);
        break;
      }
    }

    // Normalize as affiliate/rebate (percent)
    const normalized = await normalizers.normalizeBatch(pages.map(remapOfferToRaw), 'affiliate');

    // For affiliate cashback, we prefer offer.type='rebate' percent
    normalized.forEach((c) => {
      c.offer.type = 'rebate';
      c.offer.value = c.pricing?.computed?.discountPct ?? c.offer.value ?? null;
      // stacking: cashback usually stacks with manufacturer/store unless terms forbid
      c.offer.stackable = { withManufacturer: true, withStore: true, withLoyalty: true, withRebate: false, withPromoCode: true };
      // affiliate watchKey should key by merchant/store (session/schedule favorites)
      if (!c.watchKey?.storeId && c.store?.id) c.watchKey.storeId = c.store.id;
    });

    const ranked = normalizers.dedupeAndRank(normalized);
    const withFavs = await normalizers.flagFavorites(ranked);

    analytics.track('coupon_provider_listed', { provider: 'rakuten', count: withFavs.length, merchantId: merchantId || 'all' });
    eventBus.emit('coupon:provider:sync', { provider: 'rakuten', count: withFavs.length, merchantId: merchantId || 'all' });

    return withFavs;
  }

  async function syncAndRank() {
    return list({ merchantId: null, pageSize: 150, maxPages: 3, forceRefresh: false });
  }

  // ---------- click / activation (deeplink) ----------------------------------
  // Returns a URL to open in a new tab; caller decides to window.open(...)
  async function buildClickUrl({ merchantId, offerId = null, redirectUrl } = {}) {
    if (!merchantId) throw new Error('merchantId required');

    // Respect schedule guard; still allow building URL but annotate
    const allowed = scheduleAllowed();
    await takeToken();
    const token = await getAccessToken();

    const body = {
      merchantId,
      offerId,
      siteId: affiliateParams.siteId,
      pid: affiliateParams.pid,
      redirect: redirectUrl || null,
    };

    const res = await http.post(endpoints.base + endpoints.click, body, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });

    if (res.status >= 200 && res.status < 300 && res.data?.url) {
      const url = String(res.data.url);
      const meta = { merchantId, offerId, allowed };
      sourceAttribution.attach({ provider: 'rakuten', action: 'click', ...meta });
      eventBus.emit('coupon:provider:click:url', { provider: 'rakuten', ...meta });
      analytics.track('affiliate_click_url_created', { provider: 'rakuten', ...meta });
      return { ok: true, url, scheduleAllowed: allowed };
    }

    eventBus.emit('coupon:provider:click:error', { provider: 'rakuten', merchantId, offerId, status: res.status });
    return { ok: false, status: String(res.status || 'error') };
  }

  // ---------- favorites glue (merchant watch) --------------------------------
  async function upsertFavoriteMerchant(merchantId, opts = {}) {
    if (!merchantId) return;
    await favorites.upsertWatch({ storeId: merchantId }, {
      notify: true,
      minPct: opts.minPct ?? 3,
      channels: opts.channels || ['toast'],
      notes: `Watch cashback at ${merchantId}`,
    });
    analytics.track('affiliate_watch_upserted', { provider: 'rakuten', merchantId });
  }

  // ---------- diagnostics ----------------------------------------------------
  async function getStatus() {
    const token = await tokenStore.get();
    return {
      provider: 'rakuten',
      tokenValid: !!(token?.accessToken && token?.expiresAtISO && asDate(token.expiresAtISO) > clock.now()),
      nextRefreshISO: token?.expiresAtISO || null,
      scheduleAllowed: scheduleAllowed(),
    };
  }

  // ---------- optional: pull merchants + annotate best rate ------------------
  async function listTopMerchantsByRate({ pageSize = 100, maxPages = 2, forceRefresh = false } = {}) {
    // Fetch merchants then current offers; compute max rate per merchant.
    const merchants = [];
    for (let p = 1; p <= Math.max(1, maxPages); p++) {
      try {
        const m = await fetchMerchants({ page: p, pageSize, forceRefresh });
        if (!m?.length) break;
        merchants.push(...m);
      } catch (e) {
        console.warn('[Rakuten] merchants fetch failed', p, e?.message);
        break;
      }
    }

    // Offers for all merchants (first page to keep light)
    const offers = await fetchOffers({ page: 1, pageSize: pageSize * maxPages, forceRefresh }).catch(() => []);
    const maxByMerchant = new Map();
    for (const o of offers || []) {
      const mid = o.merchantId || o.storeId;
      const pct = Number(o.rate ?? o.percent ?? o.cashbackPercent ?? 0);
      const prev = maxByMerchant.get(mid) || 0;
      if (pct > prev) maxByMerchant.set(mid, pct);
    }

    return merchants
      .map((m) => ({
        merchantId: m.id || m.merchantId,
        name: m.name,
        categories: m.categories || [],
        maxRatePct: maxByMerchant.get(m.id || m.merchantId) || 0,
      }))
      .sort((a, b) => (b.maxRatePct - a.maxRatePct));
  }

  // ---------- API ------------------------------------------------------------
  return {
    list,
    syncAndRank,
    buildClickUrl,
    upsertFavoriteMerchant,
    getStatus,
    listTopMerchantsByRate,
  };
}

/* -----------------------------------------------------------------------------
USAGE NOTES (wire-up hints; no imports here)

// 1) Compose with Normalizers:
import { createCouponNormalizers } from '../Normalizers.js';
import { createRakutenProvider } from './providers/RakutenProvider.js';

const normalizers = createCouponNormalizers({ clock, eventBus, analytics, sourceAttribution, favorites });
const rakuten = createRakutenProvider({
  http, clock, eventBus, analytics, tokenStore, prefs, db, normalizers, favorites, sourceAttribution,
  baseUrl: import.meta.env.VITE_RAKUTEN_BASE_URL,
  auth: { clientId: import.meta.env.VITE_RAKUTEN_CLIENT_ID, clientSecret: import.meta.env.VITE_RAKUTEN_CLIENT_SECRET }
});

// 2) Get cashback as normalized "coupons" (offer.type='rebate', value=%):
const offers = await rakuten.syncAndRank(); // already ranked + favorites flagged

// 3) Let users star a merchant session/schedule:
await rakuten.upsertFavoriteMerchant('bestbuy');

// 4) Build click/deeplink URL for activation (UI decides when to open):
const { ok, url } = await rakuten.buildClickUrl({ merchantId: 'bestbuy', offerId: offers[0]?.id, redirectUrl: window.location.href });
if (ok) window.open(url, '_blank', 'noopener,noreferrer');

// 5) Orchestrator glue:
// - Normalizers emit 'coupon:normalized' → CycleAnalyzer learns cadence.
// - SourceAttribution can display provider chain in your UI panel.

// 6) Optional Dexie schema re-use:
// db.version(1).stores({ coupon_cache: 'id, updatedAtISO' });

----------------------------------------------------------------------------- */
