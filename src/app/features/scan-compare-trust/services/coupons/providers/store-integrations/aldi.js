/* eslint-disable no-console */
// src/features/scan-compare-trust/services/coupons/providers/store-integrations/aldi.js
// ALDI Weekly Ad parser / API adapter for StoreWeeklyAdProvider registry.
// Style: ESM, DI-first, zero external deps, defensive fallbacks.

export function createAldiAdapter(deps = {}) {
  const http = deps.http || {
    async get() { return { status: 501, data: null }; },
  };
  const clock = deps.clock || { now: () => new Date() };
  const sourceAttribution = deps.sourceAttribution || { attach: () => [] };

  // -------------------- endpoints (DI friendly; replace in app env) ----------
  const endpoints = {
    baseApi:
      deps.baseApi ||
      (typeof import.meta !== "undefined" ? import.meta.env?.VITE_ALDI_API_BASE : null) ||
      "https://api.aldi.example",
    baseHtml:
      deps.baseHtml ||
      (typeof import.meta !== "undefined" ? import.meta.env?.VITE_ALDI_WEB_BASE : null) ||
      "https://www.aldi.us",

    // Weekly ad JSON per store (placeholders — wire to your real integration)
    weeklyAdApi: (storeId, page, pageSize) =>
      `${endpoints.baseApi}/v1/stores/${encodeURIComponent(storeId)}/weekly-ad?page=${page}&pageSize=${pageSize}`,

    // Store lookup by ZIP (JSON)
    storeByZipApi: (zip) =>
      `${endpoints.baseApi}/v1/stores/nearby?zip=${encodeURIComponent(zip)}&limit=1`,

    // HTML fallback (weekly ad landing)
    weeklyAdHtml: (storeId, page) =>
      `${endpoints.baseHtml}/weekly-specials?store=${encodeURIComponent(storeId)}&page=${page}`,
  };

  // ------------------------------- utils ------------------------------------
  const asISO = (d) => (d instanceof Date ? d.toISOString() : new Date(d || Date.now()).toISOString());

  const asNumber = (v) => {
    if (v == null) return null;
    const n = Number(String(v).replace(/[^\d.-]/g, ""));
    return Number.isFinite(n) ? n : null;
  };

  const pickImages = (img) => {
    if (!img) return [];
    if (Array.isArray(img)) return img.filter(Boolean);
    if (typeof img === "string") return [img];
    return [img?.primary, img?.thumbnail, img?.url].filter(Boolean);
  };

  function computePercentOff(listPrice, salePrice) {
    if (listPrice == null || salePrice == null || listPrice <= 0) return null;
    const pct = ((listPrice - salePrice) / listPrice) * 100;
    return Math.round(pct * 100) / 100;
  }

  function toRawItemBase({ storeId, storeName, region, adapterId }) {
    return {
      id: "", title: "",
      brandName: null, brandId: null,
      upc: null, sku: null, gtin: null,
      categoryPath: [],
      storeId, storeName, region,
      listPrice: null, price: null, unit: null, size: null,
      percentOff: null, amountOff: null, priceDrop: null,
      minQty: null, minSpend: null, buyQty: null, getQty: null, getPct: null,
      loyaltyRequired: false, newCustomerOnly: false,
      startDate: null, endDate: null,
      limitPerTxn: null, limitPerCustomer: null, limitPerDay: null,
      exclusions: [], terms: null, images: [],
      adapterId,
    };
  }

  // -------------------------- store resolution -------------------------------
  async function resolveStoreContext(zip, storeId) {
    if (storeId) return { storeId, storeName: "ALDI", region: zip || null };
    if (!zip) return { storeId: "aldi", storeName: "ALDI", region: null };
    try {
      const res = await http.get(endpoints.storeByZipApi(zip));
      if (res.status >= 200 && res.status < 300 && res.data?.stores?.length) {
        const s = res.data.stores[0];
        return {
          storeId: String(s.id || s.storeId || "aldi"),
          storeName: s.name || "ALDI",
          region: zip,
        };
      }
    } catch (e) {
      console.warn("[AldiAdapter] resolveStoreContext failed; fallback to generic", e?.message);
    }
    return { storeId: "aldi", storeName: "ALDI", region: zip || null };
  }

  // --------------------------- API MODE (JSON) -------------------------------
  function mapApiItemToRaw(ai, storeCtx, adapterId) {
    // ALDI weekly ad often features “ALDI Finds” + “Grocery” promos with simple price callouts.
    const title = ai?.title || ai?.name || ai?.headline || "";
    const listPrice = asNumber(ai?.regularPrice ?? ai?.listPrice ?? ai?.msrp);
    const salePrice = asNumber(ai?.salePrice ?? ai?.price ?? ai?.promoPrice);

    const raw = toRawItemBase({ ...storeCtx, adapterId });
    raw.id = String(ai?.id || ai?.sku || ai?.itemId || title || Math.random());
    raw.title = title;

    raw.brandName = ai?.brand || ai?.brandName || "ALDI"; // many items are house brand
    raw.brandId = raw.brandName ? raw.brandName.toLowerCase().replace(/\s+/g, "-") : null;

    raw.upc = ai?.upc || null;
    raw.gtin = ai?.gtin || null;
    raw.sku = ai?.sku || null;

    raw.size = ai?.size || ai?.variant || null;
    raw.unit = ai?.unit || ai?.uom || null;
    raw.categoryPath = Array.isArray(ai?.categoryPath)
      ? ai.categoryPath
      : ai?.category
      ? [ai.category]
      : [];

    raw.listPrice = listPrice;
    raw.price = salePrice != null ? salePrice : asNumber(ai?.price);
    raw.priceDrop = raw.price != null ? `$${raw.price}` : null;
    raw.percentOff = computePercentOff(listPrice, raw.price);
    raw.amountOff = listPrice != null && raw.price != null
      ? `$${(listPrice - raw.price).toFixed(2)}`
      : null;

    // ALDI usually has no loyalty card pricing
    raw.loyaltyRequired = false;

    // Windows (ALDI weekly ad typically Wed–Tue or Sun–Sat depending on region)
    raw.startDate = ai?.startDate || ai?.validFrom || null;
    raw.endDate = ai?.endDate || ai?.validTo || null;

    raw.limitPerCustomer = ai?.limitPerCustomer ?? null;
    raw.limitPerTxn = ai?.limitPerTransaction ?? null;
    raw.terms = ai?.terms || null;
    raw.exclusions = (ai?.exclusions || []).filter(Boolean);

    raw.images = pickImages(ai?.images || ai?.image || ai?.imageUrl);

    sourceAttribution.attach({
      provider: "weeklyad",
      retailer: "aldi",
      mode: "api",
      itemId: raw.id,
      ts: asISO(clock.now()),
    });

    return raw;
  }

  async function fetchApiPage(storeCtx, { page, pageSize }) {
    const url = endpoints.weeklyAdApi(storeCtx.storeId, page, pageSize);
    const res = await http.get(url);
    if (!(res.status >= 200 && res.status < 300)) {
      return { items: [], nextPage: null, ok: false };
    }
    const arr = Array.isArray(res.data?.items)
      ? res.data.items
      : (Array.isArray(res.data?.adItems) ? res.data.adItems : []);
    const mapped = arr.map((ai) => mapApiItemToRaw(ai, storeCtx, "aldi"));
    const nextPage =
      typeof res.data?.nextPage === "number"
        ? res.data.nextPage
        : (arr.length >= pageSize ? page + 1 : null);

    return { items: mapped, nextPage, ok: true };
  }

  // ------------------------- HTML MODE (fallback) ----------------------------
  function extractJsonBlocks(html) {
    const blocks = [];
    // JSON-LD (product/offer lists)
    const ld = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
    let m;
    while ((m = ld.exec(html))) {
      try { blocks.push(JSON.parse(m[1])); } catch {}
    }
    // Redux/initial state blobs (site dependent)
    const bootstrap = /__ALDI__INITIAL_STATE__\s*=\s*({[\s\S]*?});?\s*<\/script>/i;
    const m2 = bootstrap.exec(html);
    if (m2) { try { blocks.push(JSON.parse(m2[1])); } catch {} }
    return blocks;
  }

  function parseHtmlItems(html, storeCtx) {
    const items = [];

    // 1) Prefer structured blocks
    const blocks = extractJsonBlocks(html);
    for (const b of blocks) {
      const arrays = [];
      Object.keys(b || {}).forEach((k) => {
        const v = b[k];
        if (Array.isArray(v)) arrays.push(v);
        else if (v && typeof v === "object") {
          Object.keys(v).forEach((k2) => {
            if (Array.isArray(v[k2])) arrays.push(v[k2]);
          });
        }
      });

      for (const arr of arrays) {
        for (const it of arr) {
          if (!it || typeof it !== "object") continue;
          const maybeTitle = it.title || it.name || it.headline || null;
          const maybePrice = it.price || it.priceSpecification?.price || it.offers?.price || null;
          if (!maybeTitle) continue;

          const raw = toRawItemBase({ ...storeCtx, adapterId: "aldi" });
          raw.id = String(it.id || it.sku || it.productID || it.usItemId || maybeTitle);
          raw.title = String(maybeTitle);
          raw.brandName = it.brand?.name || it.brand || "ALDI";
          raw.brandId = raw.brandName ? raw.brandName.toLowerCase().replace(/\s+/g, "-") : null;
          raw.upc = it.upc || it.gtin12 || null;
          raw.gtin = it.gtin || it.gtin13 || it.gtin14 || null;
          raw.sku = it.sku || it.productID || null;

          raw.listPrice = asNumber(it.msrp || it.listPrice || null);
          raw.price = asNumber(maybePrice);
          raw.priceDrop = raw.price != null ? `$${raw.price}` : null;
          raw.percentOff = computePercentOff(raw.listPrice, raw.price);

          raw.images = pickImages(it.image);
          items.push(raw);
        }
      }
      if (items.length) break;
    }

    // 2) Coarse regex fallback (price tiles)
    if (!items.length) {
      // Cards like: data-sku="123" ... aria-label="Title" ... "$12.99"
      const cardRe = /data-sku="([^"]+)"[\s\S]{0,400}?aria-label="([^"]+)"[\s\S]{0,400}?\$([\d,.]+)/gi;
      let m;
      while ((m = cardRe.exec(html))) {
        const sku = m[1];
        const title = m[2];
        const price = asNumber(m[3]);
        const raw = toRawItemBase({ ...storeCtx, adapterId: "aldi" });
        raw.id = sku;
        raw.sku = sku;
        raw.title = title;
        raw.price = price;
        raw.priceDrop = price != null ? `$${price}` : null;
        items.push(raw);
      }
    }

    if (items.length) {
      sourceAttribution.attach({
        provider: "weeklyad",
        retailer: "aldi",
        mode: "html",
        count: items.length,
        ts: asISO(clock.now()),
      });
    }

    return items;
  }

  async function fetchHtmlPage(storeCtx, { page }) {
    const url = endpoints.weeklyAdHtml(storeCtx.storeId, page);
    const res = await http.get(url, { headers: { Accept: "text/html" } });
    if (!(res.status >= 200 && res.status < 300)) {
      return { items: [], nextPage: null, ok: false };
    }
    const html = typeof res.text === "string" ? res.text : (typeof res.data === "string" ? res.data : "");
    if (!html) return { items: [], nextPage: null, ok: false };
    const items = parseHtmlItems(html, storeCtx);
    // Heuristic pagination: if we found >= 20, try next page
    const nextPage = items.length >= 20 ? page + 1 : null;
    return { items, nextPage, ok: true };
  }

  // ------------------------------- Adapter -----------------------------------
  const adapter = {
    id: () => "aldi",

    // Accept “aldi” literal or numeric store codes
    canHandle: ({ storeId }) => /aldi/i.test(String(storeId || "")) || /^\d{3,}$/.test(String(storeId || "")),

    /**
     * fetchIndex(ctx, { storeId, zip, page, pageSize })
     * ctx: { http, clock, eventBus, analytics, sourceAttribution }
     */
    async fetchIndex(ctx, { storeId, zip, page = 1, pageSize = 120 }) {
      const httpClient = ctx?.http || http;
      const sat = ctx?.sourceAttribution || sourceAttribution;

      // 1) Resolve store
      const storeCtx = await resolveStoreContext(zip, storeId);

      // 2) API first
      let apiRes;
      try {
        apiRes = await fetchApiPage(storeCtx, { page, pageSize });
      } catch {
        apiRes = { ok: false, items: [], nextPage: null };
      }
      if (apiRes?.ok && apiRes.items?.length) {
        sat.attach({
          provider: "weeklyad",
          retailer: "aldi",
          mode: "api",
          storeId: storeCtx.storeId,
          page,
          ts: asISO(clock.now()),
        });
        return { items: apiRes.items, nextPage: apiRes.nextPage ?? null };
      }

      // 3) HTML fallback
      let htmlRes;
      try {
        // temporarily use ctx http for HTML (if different)
        const orig = http.get;
        http.get = httpClient.get.bind(httpClient);
        htmlRes = await fetchHtmlPage(storeCtx, { page });
        http.get = orig;
      } catch (e) {
        console.warn("[AldiAdapter] HTML fallback failed", e?.message);
        htmlRes = { ok: false, items: [], nextPage: null };
      }

      if (htmlRes?.ok && htmlRes.items?.length) {
        return { items: htmlRes.items, nextPage: htmlRes.nextPage ?? null };
      }

      // 4) Nothing found
      return { items: [], nextPage: null };
    },
  };

  return adapter;
}

/* -----------------------------------------------------------------------------
USAGE (inside StoreWeeklyAdProvider boot)
-------------------------------------------------------------------------------

import { createStoreWeeklyAdProvider } from '../StoreWeeklyAdProvider.js';
import { createAldiAdapter } from './store-integrations/aldi.js';

const weeklyAd = createStoreWeeklyAdProvider({
  http, clock, eventBus, analytics, prefs, db, normalizers, favorites, sourceAttribution, cycleAnalyzer
});

weeklyAd.registerAdapter(createAldiAdapter({ http, clock, sourceAttribution }));

// Example:
const aldiDeals = await weeklyAd.syncAndRankFor('aldi', { zip: '60637', pageSize: 120 });

// Notes:
/// - Replace placeholder endpoints with your actual ALDI integration.
/// - Adapter returns RawAdItem[]; StoreWeeklyAdProvider will normalize → rank → flag favorites.
/// - Normalizers will compute watchKey (store • brand • sku) so users can favorite sessions/schedules.
/// - CycleAnalyzer learning is triggered upstream in StoreWeeklyAdProvider.

----------------------------------------------------------------------------- */
