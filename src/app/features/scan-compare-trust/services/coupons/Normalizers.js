/* eslint-disable no-console */
// src/features/scan-compare-trust/services/coupons/Normalizers.js
// Normalize coupons to a canonical shape across providers (storeAPI, scrape, receipt, user).
// Style: ES2015-safe, defensive DI, zero external deps, orchestration-friendly.

/**
 * CanonicalCoupon (output)
 * -----------------------------------------------------------------------------
 * {
 *   id: string,                    // stable hash of provider+nativeId+sku/brand
 *   provider: 'storeAPI'|'scrape'|'receipt'|'user'|'affiliate'|'unknown',
 *   providerIds: { nativeId?:string, affiliateId?:string, storeCouponId?:string },
 *   watchKey: { storeId?:string, brandId?:string, sku?:string }, // for favorites/schedules
 *
 *   store: { id?:string, name?:string, region?:string[] },
 *   brand: { id?:string, name?:string },
 *   product: {
 *     sku?:string, upc?:string, gtin?:string, title?:string, size?:string, unit?:string,
 *     categoryPath?: string[]
 *   },
 *
 *   offer: {
 *     type: 'percent'|'amount'|'bogo'|'bundle'|'loyalty'|'priceDrop'|'promoCode'|'rebate',
 *     value: number|null,          // percent 0-100 or currency amount (in minor units or float)
 *     currency: 'USD',             // only for amount/priceDrop/rebate
 *     code?: string|null,          // promo code if required
 *     minQty?: number|null,        // qualifiers
 *     minSpend?: number|null,      // in currency units
 *     buyQty?: number|null,        // for bogo/bundle (buy X)
 *     getQty?: number|null,        // for bogo/bundle (get Y)
 *     getPct?: number|null,        // for bogo (free=100)
 *     stackable: {
 *       withManufacturer: boolean,
 *       withStore: boolean,
 *       withLoyalty: boolean,
 *       withRebate: boolean,
 *       withPromoCode: boolean
 *     },
 *     loyaltyRequired: boolean,
 *     newCustomerOnly?: boolean
 *   },
 *
 *   window: {
 *     startISO?: string|null,
 *     endISO?: string|null,
 *     daysLeft?: number|null,
 *     isActive: boolean
 *   },
 *
 *   limits: {
 *     perTransaction?: number|null,
 *     perCustomer?: number|null,
 *     perDay?: number|null
 *   },
 *
 *   exclusions: string[],          // raw text exclusions
 *   notes: string[],               // human-readable extras & OCR confidence
 *   images: string[],              // thumbnails/barcodes when available
 *
 *   pricing: {
 *     listPrice?: number|null,     // currency
 *     salePrice?: number|null,     // currency
 *     computed: {
 *       discountPct?: number|null, // derived best-guess %
 *       discountAmt?: number|null, // derived currency amount
 *       effectiveUnit?: { qty:number, unit:string, price:number|null } | null
 *     }
 *   },
 *
 *   eligibility: {
 *     locations?: string[]|null,   // storeIds or region codes
 *     audience?: string[]|null,    // 'student','veteran','senior', etc.
 *     channel?: string[]|null      // 'in-store','online','app'
 *   },
 *
 *   legal: { terms?: string|null },
 *   source: { raw?: any, fetchedAtISO?: string, sources?: string[] },
 *   confidence: number             // 0..1 (parsing/normalization confidence)
 * }
 */

export function createCouponNormalizers(deps = {}) {
  const clock = deps.clock || { now: () => new Date() };
  const eventBus = deps.eventBus || { emit: () => {} };
  const analytics = deps.analytics || { track: () => {} };
  const sourceAttribution = deps.sourceAttribution || { attach: () => [] };
  const favorites = deps.favorites || {
    // For user-owned favorites/schedules (sessions)
    // Expect getWatchlist(), upsertWatch(key,obj)
    getWatchlist: async () => [],
    upsertWatch: async () => {},
  };

  // ------------------------------ helpers -----------------------------------

  const iso = (d) => (d instanceof Date ? d.toISOString() : new Date(d).toISOString());
  const asDate = (x) => (x instanceof Date ? x : new Date(x));
  const dayDiff = (a, b) => Math.ceil(Math.abs(asDate(a) - asDate(b)) / 86400000);

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const toNumber = (v) => (v == null ? null : Number(String(v).replace(/[^\d.-]/g, '')));

  const cleanStr = (s) => (typeof s === 'string' ? s.trim() : s);
  const lower = (s) => (typeof s === 'string' ? s.toLowerCase() : s);

  function hashStable(obj) {
    try {
      const s = JSON.stringify(obj, Object.keys(obj).sort());
      // poor-man’s 53-bit hash
      let h = 0;
      for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
      return `c_${Math.abs(h)}`;
    } catch {
      return `c_${Math.floor(Math.random() * 1e9)}`;
    }
  }

  function parsePct(v) {
    if (v == null) return null;
    const n = toNumber(v);
    if (n == null) return null;
    return clamp(n, 0, 100);
  }

  function parseMoney(v) {
    if (v == null || v === '') return null;
    // Accept "$1.50", "1.50", 1.5, "150 cents"
    const s = String(v).trim();
    const centsMatch = s.match(/(\d+)\s*cents?/i);
    if (centsMatch) return Number(centsMatch[1]) / 100;
    const n = toNumber(s.replace(/[$,]/g, ''));
    return Number.isFinite(n) ? Number(n.toFixed(2)) : null;
  }

  function parseDateAny(v) {
    if (!v) return null;
    const d = new Date(v);
    return Number.isFinite(d.getTime()) ? d : null;
  }

  function normalizeWindow(startLike, endLike) {
    const now = clock.now();
    const start = parseDateAny(startLike);
    const end = parseDateAny(endLike);
    const isActive =
      (!!start ? now >= start : true) &&
      (!!end ? now <= end : true);
    const daysLeft = end ? Math.max(0, dayDiff(end, now)) : null;
    return {
      startISO: start ? iso(start) : null,
      endISO: end ? iso(end) : null,
      daysLeft,
      isActive,
    };
  }

  function inferDiscountMath(offer, listPrice, salePrice) {
    const out = { discountPct: null, discountAmt: null, effectiveUnit: null };
    if (offer.type === 'percent') {
      out.discountPct = offer.value ?? null;
      if (listPrice != null && out.discountPct != null) {
        out.discountAmt = Number(((listPrice * out.discountPct) / 100).toFixed(2));
      }
    } else if (offer.type === 'amount' || offer.type === 'priceDrop' || offer.type === 'rebate') {
      out.discountAmt = parseMoney(offer.value);
      if (listPrice != null && out.discountAmt != null && listPrice > 0) {
        out.discountPct = Number(((out.discountAmt / listPrice) * 100).toFixed(2));
      }
    } else if (offer.type === 'bogo') {
      // crude: BOGO translates to 50% if buy 1 get 1 free, else proportional
      const buy = offer.buyQty || 1;
      const get = offer.getQty || 1;
      const getPct = offer.getPct != null ? offer.getPct : 100;
      const assumedPct = clamp((get / (buy + get)) * (getPct / 100) * 100, 0, 100);
      out.discountPct = Number(assumedPct.toFixed(2));
    }
    // salePrice sometimes provided by pricing service
    if (listPrice != null && salePrice != null && listPrice > 0) {
      const pct = ((listPrice - salePrice) / listPrice) * 100;
      out.discountPct = Number(pct.toFixed(2));
      out.discountAmt = Number((listPrice - salePrice).toFixed(2));
    }
    return out;
  }

  function defaultStackability({ isManufacturer, requiresLoyalty, usesPromoCode }) {
    return {
      withManufacturer: !isManufacturer, // MFR coupons rarely stack with each other
      withStore: isManufacturer,         // MFR + store often allowed
      withLoyalty: !usesPromoCode && true,
      withRebate: true,
      withPromoCode: !requiresLoyalty,
    };
  }

  function makeWatchKey(storeId, brandId, sku) {
    const key = {};
    if (storeId) key.storeId = storeId;
    if (brandId) key.brandId = brandId;
    if (sku) key.sku = sku;
    return key;
  }

  // -------------------------- provider registry ------------------------------

  const registry = new Map();

  /**
   * register(providerName, fn(raw, ctx) => CanonicalCoupon | null)
   * ctx: { now, attachSources(meta), emit(evt,payload) }
   */
  function register(providerName, fn) {
    registry.set(providerName, fn);
  }

  // ----------------------------- core normalize ------------------------------

  function toCanonicalBase() {
    return {
      id: '',
      provider: 'unknown',
      providerIds: {},
      watchKey: {},
      store: {},
      brand: {},
      product: { categoryPath: [] },
      offer: {
        type: 'amount',
        value: null,
        currency: 'USD',
        code: null,
        minQty: null,
        minSpend: null,
        buyQty: null,
        getQty: null,
        getPct: null,
        stackable: defaultStackability({ isManufacturer: false, requiresLoyalty: false, usesPromoCode: false }),
        loyaltyRequired: false,
      },
      window: { startISO: null, endISO: null, daysLeft: null, isActive: true },
      limits: {},
      exclusions: [],
      notes: [],
      images: [],
      pricing: { listPrice: null, salePrice: null, computed: { discountPct: null, discountAmt: null, effectiveUnit: null } },
      eligibility: { locations: null, audience: null, channel: null },
      legal: { terms: null },
      source: { raw: null, fetchedAtISO: null, sources: [] },
      confidence: 0.6,
    };
  }

  function finalizeCoupon(c) {
    // ensure id
    if (!c.id) {
      c.id = hashStable({
        p: c.provider,
        nid: c.providerIds?.nativeId,
        sku: c.product?.sku,
        b: c.brand?.id || c.brand?.name,
        s: c.store?.id,
        t: c.offer?.type,
        v: c.offer?.value,
        w: c.window?.endISO,
      });
    }
    // compute math
    const math = inferDiscountMath(c.offer, c.pricing.listPrice, c.pricing.salePrice);
    c.pricing.computed = { ...c.pricing.computed, ...math };
    // watch key
    const wk = makeWatchKey(c.store.id, c.brand.id, c.product.sku || c.product.upc);
    c.watchKey = wk;
    return c;
  }

  async function normalize(raw, provider = 'unknown') {
    const base = toCanonicalBase();
    base.provider = provider;
    base.source.raw = raw;
    base.source.fetchedAtISO = iso(clock.now());
    base.source.sources = sourceAttribution.attach(raw?.meta || {});
    const ctx = {
      now: clock.now(),
      attachSources: (meta) => sourceAttribution.attach(meta || {}),
      emit: (evt, payload) => eventBus.emit(evt, payload),
    };

    let c = null;
    const fn = registry.get(provider);
    if (fn) {
      try {
        c = await fn(raw, ctx);
      } catch (e) {
        console.warn(`[Normalizers] provider "${provider}" failed`, e);
      }
    }
    if (!c) {
      // Fallback heuristic normalizer
      c = fallbackHeuristic(raw, provider);
    }

    // merge on base and finalize
    const merged = finalizeCoupon({ ...base, ...c });
    analytics.track('coupon_normalized', {
      provider,
      id: merged.id,
      storeId: merged.store?.id,
      brandId: merged.brand?.id,
      sku: merged.product?.sku || merged.product?.upc,
      type: merged.offer?.type,
    });

    // Emit to orchestration (e.g., to CycleAnalyzer for learning)
    eventBus.emit('coupon:normalized', { coupon: merged });

    return merged;
  }

  async function normalizeBatch(arr, provider) {
    const out = [];
    for (const raw of arr || []) {
      const c = await normalize(raw, provider);
      if (c) out.push(c);
    }
    return out;
  }

  // -------------------- fallback & common provider normalizers ----------------

  function fallbackHeuristic(raw, provider) {
    const c = toCanonicalBase();
    c.provider = provider || 'unknown';

    const storeId = raw.storeId || raw.store?.id || raw.storeCode;
    const brandId = raw.brandId || raw.brand?.id || null;
    const sku = raw.sku || raw.product?.sku || raw.upc || raw.gtin || null;

    c.store = { id: cleanStr(storeId), name: raw.storeName || raw.store?.name };
    c.brand = { id: cleanStr(brandId), name: raw.brandName || raw.brand?.name };
    c.product = {
      sku: cleanStr(sku),
      upc: cleanStr(raw.upc),
      gtin: cleanStr(raw.gtin),
      title: cleanStr(raw.title || raw.productName),
      size: cleanStr(raw.size),
      unit: cleanStr(raw.unit),
      categoryPath: Array.isArray(raw.categoryPath) ? raw.categoryPath : (raw.categoryPath ? [raw.categoryPath] : []),
    };

    // Offer inference
    const rawPct = parsePct(raw.percentOff || raw.discountPct);
    const rawAmt = parseMoney(raw.amountOff || raw.discountAmount);
    const type = rawPct != null ? 'percent' : (rawAmt != null ? 'amount' : 'priceDrop');
    const value = rawPct != null ? rawPct : (rawAmt != null ? rawAmt : parseMoney(raw.priceDrop));
    const loyalty = !!(raw.loyaltyRequired || raw.loyalty);
    const usesCode = !!(raw.code || raw.promoCode);

    c.offer = {
      type,
      value: value ?? null,
      currency: raw.currency || 'USD',
      code: raw.code || raw.promoCode || null,
      minQty: toNumber(raw.minQty) || null,
      minSpend: parseMoney(raw.minSpend),
      buyQty: toNumber(raw.buyQty) || null,
      getQty: toNumber(raw.getQty) || null,
      getPct: parsePct(raw.getPct),
      stackable: defaultStackability({ isManufacturer: !!raw.manufacturer, requiresLoyalty: loyalty, usesPromoCode: usesCode }),
      loyaltyRequired: loyalty,
      newCustomerOnly: !!raw.newCustomerOnly,
    };

    c.window = normalizeWindow(raw.startDate || raw.validFrom, raw.endDate || raw.validTo);
    c.limits = {
      perTransaction: toNumber(raw.limitPerTxn) || null,
      perCustomer: toNumber(raw.limitPerCustomer) || null,
      perDay: toNumber(raw.limitPerDay) || null,
    };

    c.exclusions = []
      .concat(raw.exclusions || [])
      .concat(raw.terms || raw.legal || [])
      .filter(Boolean)
      .map(cleanStr);

    c.legal.terms = cleanStr(raw.termsText || raw.terms);
    c.images = (raw.images || raw.thumbs || []).filter(Boolean);
    c.pricing.listPrice = parseMoney(raw.listPrice);
    c.pricing.salePrice = parseMoney(raw.salePrice);

    // Confidence heuristic
    let conf = 0.55;
    if (c.store.id) conf += 0.1;
    if (c.brand.id || c.product.sku || c.product.upc) conf += 0.1;
    if (c.offer.value != null) conf += 0.1;
    if (c.window.endISO) conf += 0.1;
    c.confidence = clamp(conf, 0, 0.95);

    // Native id if present
    const nativeId = raw.id || raw.couponId || raw.offerId || null;
    if (nativeId) c.providerIds.nativeId = String(nativeId);

    return c;
  }

  // Example detailed normalizers (wire more as you add providers)
  register('storeAPI', (raw) => {
    const c = fallbackHeuristic(raw, 'storeAPI');
    // store APIs often give strong dates and stackability flags
    if ('stackable' in raw) {
      c.offer.stackable = {
        withManufacturer: !!raw.stackable?.withManufacturer,
        withStore: !!raw.stackable?.withStore,
        withLoyalty: !!raw.stackable?.withLoyalty ?? true,
        withRebate: !!raw.stackable?.withRebate ?? true,
        withPromoCode: !!raw.stackable?.withPromoCode ?? true,
      };
    }
    // loyalty Required?
    if (raw.price && raw.listPrice) {
      c.pricing.listPrice = parseMoney(raw.listPrice);
      c.pricing.salePrice = parseMoney(raw.price);
    }
    return c;
  });

  register('receipt', (raw) => {
    // raw lines from receipts, OCR’d codes, etc.
    const c = fallbackHeuristic(raw, 'receipt');
    // receipts rarely include end date; set short active window
    const now = clock.now();
    const end = new Date(now);
    end.setDate(end.getDate() + 7);
    c.window = normalizeWindow(now, end);
    c.notes.push('Derived from receipt/OCR; end date assumed +7d.');
    c.confidence = clamp(c.confidence - 0.05, 0, 1);
    return c;
  });

  register('user', (raw) => {
    const c = fallbackHeuristic(raw, 'user');
    c.notes.push('User-entered coupon.');
    // honor user-entered stackability if present
    if (raw.stackable) c.offer.stackable = { ...c.offer.stackable, ...raw.stackable };
    // allow promo codes explicitly
    if (raw.promoCode) c.offer.code = raw.promoCode;
    c.confidence = clamp(c.confidence + 0.1, 0, 1);
    return c;
  });

  register('affiliate', (raw) => {
    const c = fallbackHeuristic(raw, 'affiliate');
    c.providerIds.affiliateId = raw.affId || raw.linkId || null;
    // affiliates often have promo codes + long tails
    if (raw.expiration) {
      c.window = normalizeWindow(raw.start || clock.now(), raw.expiration);
    }
    return c;
  });

  // ------------------------ merge / rank / dedupe ----------------------------

  function keyFingerprint(c) {
    return `${c.store?.id || 'na'}::${c.brand?.id || c.brand?.name || 'na'}::${c.product?.sku || c.product?.upc || 'na'}::${c.offer?.type}::${c.offer?.code || 'no-code'}`;
    }

  function dedupeAndRank(coupons = []) {
    const byKey = new Map();
    for (const c of coupons) {
      const fp = keyFingerprint(c);
      const prev = byKey.get(fp);
      if (!prev) {
        byKey.set(fp, c);
        continue;
      }
      // prefer: higher confidence, later end date, higher discount
      const prevPct = prev.pricing?.computed?.discountPct || 0;
      const curPct = c.pricing?.computed?.discountPct || 0;
      const prevEnd = prev.window?.endISO ? asDate(prev.window.endISO) : null;
      const curEnd = c.window?.endISO ? asDate(c.window.endISO) : null;

      let replace = false;
      if ((c.confidence || 0) > (prev.confidence || 0) + 0.05) replace = true;
      else if ((curEnd && (!prevEnd || curEnd > prevEnd))) replace = true;
      else if (curPct > prevPct + 0.01) replace = true;

      if (replace) byKey.set(fp, c);
    }
    // rank: active first, then daysLeft asc, then pct desc, then confidence desc
    const ranked = Array.from(byKey.values()).sort((a, b) => {
      const aActive = a.window?.isActive ? 1 : 0;
      const bActive = b.window?.isActive ? 1 : 0;
      if (bActive - aActive !== 0) return bActive - aActive;
      const aLeft = a.window?.daysLeft ?? 9999;
      const bLeft = b.window?.daysLeft ?? 9999;
      if (aLeft - bLeft !== 0) return aLeft - bLeft;
      const aPct = a.pricing?.computed?.discountPct ?? 0;
      const bPct = b.pricing?.computed?.discountPct ?? 0;
      if (bPct - aPct !== 0) return bPct - aPct;
      return (b.confidence ?? 0) - (a.confidence ?? 0);
    });
    return ranked;
  }

  // ------------------------- favorites / sessions ----------------------------

  async function flagFavorites(coupons = []) {
    // Not modifying schema; just annotate for UI convenience
    const watch = await favorites.getWatchlist().catch(() => []);
    const set = new Set((watch || []).map((k) => JSON.stringify(k)));
    return coupons.map((c) => ({
      ...c,
      _isFavorite: set.has(JSON.stringify(c.watchKey || {})),
    }));
  }

  // ------------------------------- API --------------------------------------

  return {
    register,
    normalize,
    normalizeBatch,
    dedupeAndRank,
    flagFavorites,

    // expose helpers (useful in other services)
    _helpers: {
      parsePct, parseMoney, parseDateAny, normalizeWindow,
      inferDiscountMath, defaultStackability,
    },
  };
}

/* -----------------------------------------------------------------------------
USAGE HINTS (no imports here; just guidance):

// 1) Create instance where you wire your Coupons service:
const normalizers = createCouponNormalizers({ clock, eventBus, analytics, sourceAttribution, favorites });

// 2) Normalize from provider responses:
const rawList = await fetchStoreCoupons(); // provider-shaped objects
const normalized = await normalizers.normalizeBatch(rawList, 'storeAPI');

// 3) Dedupe/rank + favorites flag for UI:
const ranked = normalizers.dedupeAndRank(normalized);
const rankedWithFavs = await normalizers.flagFavorites(ranked);

// 4) Emit to pricing/CycleAnalyzer: the Normalizers module already emits 'coupon:normalized'.
//    Your CycleAnalyzer.onScanResultResolved() can also learn cadence from these.

// 5) Add new providers easily:
// normalizers.register('krogerAPI', (raw, ctx) => {
//   const c = { ...fallbackHeuristic(raw, 'krogerAPI') };
//   c.store.id = raw.retailerId || 'kroger';
//   c.offer.type = raw.offerType?.toLowerCase() === 'percent' ? 'percent' : 'amount';
//   c.offer.value = c.offer.type === 'percent' ? parsePct(raw.offerValue) : parseMoney(raw.offerValue);
//   c.window = normalizeWindow(raw.startDate, raw.endDate);
//   c.confidence = 0.85;
//   return c;
// });

----------------------------------------------------------------------------- */
