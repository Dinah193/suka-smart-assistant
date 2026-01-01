/* eslint-disable no-console */
// src/features/scan-compare-trust/services/coupons/providers/IbottaProvider.js
// Rebates provider (Ibotta-style).
// Style: ES2015-safe, DI-first, browser/node friendly, zero external deps here.

export function createIbottaProvider(deps = {}) {
  // ---------- DI (safe defaults) --------------------------------------------
  const http = deps.http || {
    async get() { return { status: 501, data: null }; },
    async post() { return { status: 501, data: null }; },
    async put() { return { status: 501, data: null }; },
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

  // ---------- Provider endpoints (DI via env) --------------------------------
  const endpoints = {
    base: deps.baseUrl || 'https://api.ibotta.example', // placeholder
    offers: '/v1/offers',              // ?retailerId=&page=&pageSize=
    offerActivate: '/v1/offers/activate', // POST { offerId, retailerId, loyaltyId? }
    linkLoyalty: '/v1/loyalty/link',   // POST { retailerId, loyaltyId }
    receiptUpload: '/v1/receipts',     // POST multipart/form-data
    token: '/oauth/token',
  };

  // ---------- Guards & utils -------------------------------------------------
  const asDate = (x) => (x instanceof Date ? x : new Date(x));
  const iso = (d) => (d instanceof Date ? d.toISOString() : new Date(d).toISOString());

  function withinQuietHours(now = clock.now()) {
    const qh = (prefs.quietHours && (prefs.quietHours.value || prefs.quietHours)) || { start: 21, end: 7 };
    const h = asDate(now).getHours();
    if (qh.start < qh.end) return h >= qh.start && h < qh.end;
    return h >= qh.start || h < qh.end; // overnight
  }
  function sabbathActive(now = clock.now()) {
    const g = prefs.sabbathGuard?.enabled ? prefs.sabbathGuard : { enabled: false };
    if (!g.enabled) return false;
    const day = asDate(now).getDay(); // 0 Sun .. 6 Sat
    return day === 5 || day === 6; // Fri/Sat heuristic
  }
  function scheduleAllowed(now = clock.now()) {
    return !withinQuietHours(now) && !sabbathActive(now);
  }

  // Token bucket: burst 4, ~1 rps thereafter
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

  // ---------- Cache helpers (Dexie) -----------------------------------------
  async function cachePut(id, rows) {
    if (!db?.table) return;
    try { await db.table('coupon_cache').put({ id, rows, updatedAtISO: iso(clock.now()) }); }
    catch (e) { console.warn('[Ibotta] cachePut failed', e); }
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

  // ---------- Raw → Normalizers mapping -------------------------------------
  function remapRebateToRaw(o) {
    // Typical rebate offer includes retailer, brand, UPC list, value ($ or %), limits, expiry.
    const retailerId = o.retailerId || o.storeId || null;
    const retailerName = o.retailerName || o.storeName || null;
    const upc = Array.isArray(o.upcs) ? o.upcs[0] : (o.upc || null);
    const sku = o.sku || null;

    // Represent rebate as "rebate" (amount or percent). Normalizers will compute.
    const valueStr = o.valueType === 'percent' ? (o.value + '%') : (o.valueCurrency || '$') + o.value;
    return {
      id: o.id || o.offerId,
      provider: 'ibotta',
      storeId: retailerId,
      storeName: retailerName,
      brandId: o.brandId || (o.brandName ? o.brandName.toLowerCase().replace(/\s+/g, '-') : null),
      brandName: o.brandName || null,
      sku,
      upc,
      gtin: o.gtin || null,
      title: o.title || o.headline || '',
      size: o.size || null,
      unit: o.unit || null,
      categoryPath: o.categories || (o.category ? [o.category] : []),
      // Offer-ish fields understood by our Normalizers fallback:
      percentOff: o.valueType === 'percent' ? o.value : null,
      amountOff: o.valueType === 'amount' ? valueStr : null, // e.g. "$1.00"
      priceDrop: null,
      minQty: o.minQty || 1,
      minSpend: o.minSpend || null,
      loyaltyRequired: !!o.loyaltyRequired,
      manufacturer: false, // rebate
      newCustomerOnly: !!o.newCustomerOnly,
      // BOGO-style rebates sometimes exist:
      buyQty: o.buyQty || null,
      getQty: o.getQty || null,
      getPct: o.getPct || null,
      // Dates
      startDate: o.startDate || o.validFrom,
      endDate: o.endDate || o.expiration,
      // Limits & legal
      limitPerTxn: o.limitPerTransaction || null,
      limitPerCustomer: o.redemptionLimit || o.limitPerCustomer || null,
      limitPerDay: o.limitPerDay || null,
      exclusions: (o.exclusions || o.terms || o.notes || []).filter(Boolean),
      termsText: o.terms || null,
      images: o.images || o.thumbnails || [],
      // Pricing hints
      listPrice: null,
      salePrice: null,
      meta: {
        provider: 'ibotta',
        raw: { id: o.id, retailerId, brandId: o.brandId, upcs: o.upcs },
      },
    };
  }

  // ---------- Fetchers -------------------------------------------------------
  async function fetchOffers({ retailerId = null, page = 1, pageSize = 100, forceRefresh = false } = {}) {
    const cacheKey = `ibotta::offers::r=${retailerId || 'all'}::p=${page}::s=${pageSize}`;
    if (!forceRefresh) {
      const cached = await cacheGet(cacheKey);
      if (cached) return cached;
    }

    await takeToken();
    const token = await getAccessToken();

    const url = new URL(endpoints.base + endpoints.offers);
    if (retailerId) url.searchParams.set('retailerId', String(retailerId));
    url.searchParams.set('page', String(page));
    url.searchParams.set('pageSize', String(pageSize));

    eventBus.emit('coupon:provider:fetch:start', { provider: 'ibotta', page, retailerId, type: 'offers' });
    const res = await http.get(url.toString(), { headers: { Authorization: `Bearer ${token}` } });

    if (!(res.status >= 200 && res.status < 300) || !Array.isArray(res.data?.offers)) {
      eventBus.emit('coupon:provider:fetch:error', { provider: 'ibotta', page, retailerId, status: res.status });
      throw new Error('Ibotta offers API failed');
    }

    await cachePut(cacheKey, res.data.offers);
    eventBus.emit('coupon:provider:fetch:success', { provider: 'ibotta', page, retailerId, count: res.data.offers.length });
    return res.data.offers;
  }

  // ---------- Listing & Normalization ---------------------------------------
  async function list({ retailerId = null, pageSize = 100, maxPages = 2, forceRefresh = false } = {}) {
    if (!normalizers) throw new Error('Normalizers instance required');

    const now = clock.now();
    if (!scheduleAllowed(now)) {
      // Return warm cache quickly when blocked by schedule guard
      const key = `ibotta::offers::r=${retailerId || 'all'}::p=1::s=${pageSize}`;
      const cached = await cacheGet(key, 60 * 60 * 1000);
      const normalized = cached ? await normalizers.normalizeBatch(cached.map(remapRebateToRaw), 'affiliate') : [];
      // Force rebate semantics
      normalized.forEach((c) => { c.offer.type = 'rebate'; });
      return normalizers.flagFavorites(normalizers.dedupeAndRank(normalized));
    }

    const pages = [];
    for (let p = 1; p <= Math.max(1, maxPages); p++) {
      try {
        const raw = await fetchOffers({ retailerId, page: p, pageSize, forceRefresh });
        if (!raw?.length) break;
        pages.push(...raw);
      } catch (e) {
        console.warn('[Ibotta] fetch offers failed', p, e?.message);
        break;
      }
    }

    // Normalize via Normalizers as 'affiliate' (rebate) for downstream consistency
    const normalized = await normalizers.normalizeBatch(pages.map(remapRebateToRaw), 'affiliate');
    normalized.forEach((c) => {
      c.offer.type = 'rebate';
      // Rebate usually stacks with store/manufacturer unless terms forbid
      c.offer.stackable = { withManufacturer: true, withStore: true, withLoyalty: true, withRebate: false, withPromoCode: true };
      // Ensure watchKey at least has storeId (retailer) and brand/sku when present
      if (!c.watchKey?.storeId && c.store?.id) c.watchKey.storeId = c.store.id;
    });

    const ranked = normalizers.dedupeAndRank(normalized);
    const withFavs = await normalizers.flagFavorites(ranked);

    analytics.track('coupon_provider_listed', { provider: 'ibotta', count: withFavs.length, retailerId: retailerId || 'all' });
    eventBus.emit('coupon:provider:sync', { provider: 'ibotta', count: withFavs.length, retailerId: retailerId || 'all' });

    return withFavs;
  }

  async function listForStore(retailerId, opts = {}) {
    return list({ retailerId, pageSize: opts.pageSize || 120, maxPages: opts.maxPages || 2, forceRefresh: !!opts.forceRefresh });
  }

  async function syncAndRank() {
    return list({ retailerId: null, pageSize: 150, maxPages: 3, forceRefresh: false });
  }

  // ---------- Offer activation / Loyalty / Receipt ---------------------------
  async function linkLoyalty({ retailerId, loyaltyId }) {
    if (!retailerId || !loyaltyId) throw new Error('retailerId and loyaltyId required');
    await takeToken();
    const token = await getAccessToken();
    const res = await http.post(endpoints.base + endpoints.linkLoyalty, { retailerId, loyaltyId }, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });
    if (res.status >= 200 && res.status < 300) {
      eventBus.emit('coupon:provider:loyalty:linked', { provider: 'ibotta', retailerId });
      analytics.track('coupon_loyalty_linked', { provider: 'ibotta', retailerId });
      return { ok: true };
    }
    return { ok: false, status: String(res.status || 'error') };
  }

  async function activateOffer({ offerId, retailerId, loyaltyId = null }) {
    if (!offerId || !retailerId) throw new Error('offerId and retailerId required');
    await takeToken();
    const token = await getAccessToken();
    const body = { offerId, retailerId, loyaltyId };
    const res = await http.post(endpoints.base + endpoints.offerActivate, body, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });
    if (res.status >= 200 && res.status < 300 && (res.data?.status === 'activated' || res.data?.ok)) {
      eventBus.emit('coupon:provider:activate:success', { provider: 'ibotta', offerId, retailerId });
      analytics.track('coupon_activate_success', { provider: 'ibotta', offerId, retailerId });
      return { ok: true, status: 'activated' };
    }
    eventBus.emit('coupon:provider:activate:error', { provider: 'ibotta', offerId, retailerId, status: res.status });
    return { ok: false, status: String(res.status || 'error') };
  }

  // Accepts { file, retailerId?, purchasedAtISO? }
  async function submitReceipt({ file, retailerId = null, purchasedAtISO = null }) {
    if (!file) throw new Error('file required');
    await takeToken();
    const token = await getAccessToken();

    // Browser FormData or Node polyfill is expected from deps.http
    const form = new FormData();
    form.append('receipt', file);
    if (retailerId) form.append('retailerId', retailerId);
    if (purchasedAtISO) form.append('purchasedAtISO', purchasedAtISO);

    const res = await http.post(endpoints.base + endpoints.receiptUpload, form, {
      headers: { Authorization: `Bearer ${token}` }, // boundary set by http client
    });

    if (res.status >= 200 && res.status < 300 && res.data?.offers) {
      // Map OCR-matched offers -> normalized coupons of provider='receipt'
      const raw = (res.data.offers || []).map((o) => ({
        id: o.id, provider: 'ibotta-receipt', storeId: retailerId || o.retailerId, brandId: o.brandId,
        upc: o.upc, sku: o.sku, title: o.title, amountOff: o.rewardAmount, percentOff: null,
        startDate: o.validFrom, endDate: o.validTo, termsText: o.terms, images: o.images, meta: { source: 'receipt-ocr' },
      }));
      if (normalizers) {
        const normalized = await normalizers.normalizeBatch(raw, 'receipt');
        const ranked = normalizers.dedupeAndRank(normalized);
        const favd = await normalizers.flagFavorites(ranked);
        eventBus.emit('coupon:provider:receipt:parsed', { provider: 'ibotta', count: favd.length });
        analytics.track('receipt_offers_parsed', { provider: 'ibotta', count: favd.length });
        return { ok: true, matches: favd };
      }
      return { ok: true, matches: [] };
    }

    eventBus.emit('coupon:provider:receipt:error', { provider: 'ibotta', status: res.status });
    return { ok: false, status: String(res.status || 'error') };
  }

  // ---------- Favorites glue -------------------------------------------------
  async function upsertFavoriteFromCoupon(c, opts = {}) {
    if (!c?.watchKey || !favorites?.upsertWatch) return;
    await favorites.upsertWatch(c.watchKey, {
      notify: opts.notify !== false,
      minPct: opts.minPct ?? 5,
      channels: opts.channels || ['toast'],
      notes: `Watch rebate cadence for ${c.brand?.name || 'item'} at ${c.store?.name || c.store?.id || 'retailer'}`,
    });
    analytics.track('rebate_watch_upserted', { provider: 'ibotta', key: JSON.stringify(c.watchKey) });
  }

  // ---------- Diagnostics ----------------------------------------------------
  async function getStatus() {
    const token = await tokenStore.get();
    return {
      provider: 'ibotta',
      tokenValid: !!(token?.accessToken && token?.expiresAtISO && asDate(token.expiresAtISO) > clock.now()),
      nextRefreshISO: token?.expiresAtISO || null,
      scheduleAllowed: scheduleAllowed(),
    };
  }

  // ---------- API ------------------------------------------------------------
  return {
    list,
    listForStore,
    syncAndRank,
    linkLoyalty,
    activateOffer,
    submitReceipt,
    upsertFavoriteFromCoupon,
    getStatus,
  };
}

/* -----------------------------------------------------------------------------
USAGE NOTES (wire-up hints; no imports here)

// 1) Compose with Normalizers in your Coupons service root:
import { createCouponNormalizers } from '../Normalizers.js';
import { createIbottaProvider } from './providers/IbottaProvider.js';

const normalizers = createCouponNormalizers({ clock, eventBus, analytics, sourceAttribution, favorites });
const ibotta = createIbottaProvider({
  http, clock, eventBus, analytics, tokenStore, prefs, db, normalizers, favorites, sourceAttribution,
  baseUrl: import.meta.env.VITE_IBOTTA_BASE_URL,
  auth: { clientId: import.meta.env.VITE_IBOTTA_CLIENT_ID, clientSecret: import.meta.env.VITE_IBOTTA_CLIENT_SECRET }
});

// 2) Pull & normalize rebates (ranked + favorites flagged):
const rebates = await ibotta.syncAndRank();

// 3) Per-store browse:
const krogerRebates = await ibotta.listForStore('kroger');

// 4) Let users star store•brand•SKU sessions/schedules:
await ibotta.upsertFavoriteFromCoupon(rebates[0], { minPct: 5 });

// 5) Link loyalty & activate offers:
await ibotta.linkLoyalty({ retailerId: 'kroger', loyaltyId: 'ABC12345' });
await ibotta.activateOffer({ offerId: rebates[0].id, retailerId: rebates[0].store.id, loyaltyId: 'ABC12345' });

// 6) Submit a receipt image/PDF (your http client must support FormData in this env):
// const file = input.files[0];
// const result = await ibotta.submitReceipt({ file, retailerId: 'walmart' });

// 7) Orchestrator glue:
// - Normalizers emit 'coupon:normalized' → CycleAnalyzer learns discount cadence.
// - SourceAttribution panel can display provider chain and receipt OCR sources.

// 8) Optional Dexie cache schema reuse:
// db.version(1).stores({ coupon_cache: 'id, updatedAtISO' });

----------------------------------------------------------------------------- */
