/* eslint-disable no-console */
// src/features/scan-compare-trust/services/coupons/providers/store-integrations/walmart.js
// Walmart Weekly Ad parser / API adapter for StoreWeeklyAdProvider registry.
// Style: ESM, DI-first, zero external deps, defensive fallbacks.

/**
 * createWalmartAdapter(deps)
 * -----------------------------------------------------------------------------
 * DI (all optional, safe defaults):
 *  - http: { get(url, opts) -> {status, data, text?}, }
 *    (If .text is missing on HTML calls, we will read data as string)
 *  - clock: { now(): Date }
 *  - sourceAttribution: { attach(meta): string[] }
 *
 * Env-ish (pass through deps or rely on import.meta.env in caller):
 *  - baseApi: Walmart public APIs (placeholder): 'https://api.walmart.example'
 *  - baseHtml: Walmart web: 'https://www.walmart.com'
 *
 * Adapter contract (consumed by StoreWeeklyAdProvider):
 *  - id(): string
 *  - canHandle({ storeId }): boolean
 *  - fetchIndex(ctx, { storeId, zip, page, pageSize }): Promise<{ items: RawAdItem[], nextPage?: number|null }>
 */

export function createWalmartAdapter(deps = {}) {
  const http = deps.http || {
    async get() { return { status: 501, data: null }; },
  };
  const clock = deps.clock || { now: () => new Date() };
  const sourceAttribution = deps.sourceAttribution || { attach: () => [] };

  // Endpoints (DI-friendly; these are *placeholders* you should replace/parametrize)
  const endpoints = {
    baseApi:
      deps.baseApi ||
      (typeof import.meta !== "undefined" ? import.meta.env?.VITE_WALMART_API_BASE : null) ||
      "https://api.walmart.example",
    baseHtml:
      deps.baseHtml ||
      (typeof import.meta !== "undefined" ? import.meta.env?.VITE_WALMART_WEB_BASE : null) ||
      "https://www.walmart.com",
    // Illustrative API shapes; adjust to your real integration:
    // Weekly ad / featured deals per store (JSON)
    weeklyAdApi: (storeId, page, pageSize) =>
      `${endpoints.baseApi}/v1/stores/${encodeURIComponent(storeId)}/weekly-ad?page=${page}&pageSize=${pageSize}`,
    // Store lookup by zip (JSON)
    storeByZipApi: (zip) =>
      `${endpoints.baseApi}/v1/stores/nearby?zip=${encodeURIComponent(zip)}&limit=1`,
    // HTML fallback (weekly ad landing)
    weeklyAdHtml: (storeId, page) =>
      `${endpoints.baseHtml}/store/${encodeURIComponent(storeId)}?weeklyAdPage=${page}`,
  };

  // ------------------------------- utils ------------------------------------

  const asNumber = (v) => {
    if (v == null) return null;
    const n = Number(String(v).replace(/[^\d.-]/g, ""));
    return Number.isFinite(n) ? n : null;
  };

  const pickImage = (images) => {
    if (!images) return [];
    if (Array.isArray(images)) return images.filter(Boolean);
    if (typeof images === "string") return [images];
    if (images?.primary) return [images.primary, images.thumbnail].filter(Boolean);
    return [];
  };

  const asISO = (d) => (d instanceof Date ? d.toISOString() : new Date(d || Date.now()).toISOString());

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

  function computePercentOff(listPrice, salePrice) {
    if (listPrice == null || salePrice == null || listPrice <= 0) return null;
    const pct = ((listPrice - salePrice) / listPrice) * 100;
    return Math.round(pct * 100) / 100;
  }

  // -------------------------- store resolution -------------------------------

  async function resolveStoreId(zip, storeId) {
    if (storeId) return { storeId, storeName: "Walmart", region: zip || null };
    if (!zip) return { storeId: "walmart", storeName: "Walmart", region: null };

    try {
      const res = await http.get(endpoints.storeByZipApi(zip));
      if (res.status >= 200 && res.status < 300 && res.data?.stores?.length) {
        const s = res.data.stores[0];
        return {
          storeId: String(s.id || s.storeId || "walmart"),
          storeName: s.name || "Walmart",
          region: zip,
        };
      }
    } catch (e) {
      console.warn("[WalmartAdapter] resolveStoreId failed; falling back", e?.message);
    }
    return { storeId: "walmart", storeName: "Walmart", region: zip };
  }

  // --------------------------- API MODE (JSON) -------------------------------

  function mapApiItemToRaw(apiItem, storeContext, adapterId) {
    // Example tolerant mapping; adjust to your actual JSON fields
    const title = apiItem?.title || apiItem?.name || apiItem?.headline || "";
    const listPrice =
      asNumber(apiItem?.listPrice ?? apiItem?.msrp ?? apiItem?.origPrice ?? null);
    const salePrice =
      asNumber(apiItem?.salePrice ?? apiItem?.price ?? apiItem?.currentPrice ?? null);

    const raw = toRawItemBase({ ...storeContext, adapterId });
    raw.id = String(apiItem?.id || apiItem?.usItemId || apiItem?.itemId || title || Math.random());
    raw.title = title;
    raw.brandName = apiItem?.brand || apiItem?.brandName || null;
    raw.brandId = raw.brandName ? raw.brandName.toLowerCase().replace(/\s+/g, "-") : null;
    raw.upc = apiItem?.upc || null;
    raw.sku = apiItem?.usItemId || apiItem?.sku || null;
    raw.gtin = apiItem?.gtin || null;

    // Product attributes
    raw.size = apiItem?.size || apiItem?.variant || null;
    raw.unit = apiItem?.unit || apiItem?.uom || null;
    raw.categoryPath = Array.isArray(apiItem?.categoryPath)
      ? apiItem.categoryPath
      : apiItem?.category
      ? [apiItem.category]
      : [];

    // Prices
    raw.listPrice = listPrice;
    raw.price = salePrice;
    raw.priceDrop = salePrice != null ? `$${salePrice}` : null;
    raw.percentOff = computePercentOff(listPrice, salePrice);
    raw.amountOff = listPrice != null && salePrice != null
      ? `$${(listPrice - salePrice).toFixed(2)}`
      : null;

    // Dates (weekly ad window; API may include start/end)
    raw.startDate = apiItem?.startDate || apiItem?.validFrom || null;
    raw.endDate = apiItem?.endDate || apiItem?.validTo || null;

    // Limits & terms
    raw.limitPerCustomer = apiItem?.limitPerCustomer ?? null;
    raw.limitPerTxn = apiItem?.limitPerTransaction ?? null;
    raw.terms = apiItem?.terms || null;
    raw.exclusions = (apiItem?.exclusions || []).filter(Boolean);

    // Images
    raw.images = pickImage(apiItem?.images || apiItem?.image || apiItem?.imageUrl);

    // SourceAttribution
    sourceAttribution.attach({
      provider: "weeklyad",
      retailer: "walmart",
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
    // Expect { items: [...], nextPage?: number|null } or similar
    const itemsArr = Array.isArray(res.data?.items)
      ? res.data.items
      : Array.isArray(res.data?.adItems)
      ? res.data.adItems
      : [];

    const mapped = itemsArr.map((ai) => mapApiItemToRaw(ai, storeCtx, "walmart"));
    const nextPage =
      typeof res.data?.nextPage === "number"
        ? res.data.nextPage
        : (itemsArr.length >= pageSize ? page + 1 : null);

    return { items: mapped, nextPage, ok: true };
  }

  // ------------------------- HTML MODE (fallback) ----------------------------

  function extractJsonBlocks(html) {
    // Try to grab structured data scripts or embedded JSON blobs
    const blocks = [];
    const jsonLdRegex = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
    let m;
    while ((m = jsonLdRegex.exec(html))) {
      try {
        const obj = JSON.parse(m[1]);
        blocks.push(obj);
      } catch {}
    }
    // Also look for window.__WML_REDUX_INITIAL_STATE__ or similar
    const reduxRegex = /__WML__INITIAL_STATE__\s*=\s*({[\s\S]*?});?\s*<\/script>/i;
    const m2 = reduxRegex.exec(html);
    if (m2) {
      try { blocks.push(JSON.parse(m2[1])); } catch {}
    }
    return blocks;
  }

  function parseHtmlItems(html, storeCtx) {
    const items = [];

    // 1) Try structured blocks first
    const blocks = extractJsonBlocks(html);
    for (const b of blocks) {
      // Heuristic: look for arrays of products or offers
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
          if (!it || (typeof it !== "object")) continue;
          const maybeTitle = it.title || it.name || it.headline || null;
          const maybePrice = it.price || it.priceSpecification?.price || it.offers?.price || null;
          if (!maybeTitle) continue;
          // Build raw item
          const raw = toRawItemBase({ ...storeCtx, adapterId: "walmart" });
          raw.id = String(it.sku || it.productID || it.usItemId || maybeTitle);
          raw.title = String(maybeTitle);
          raw.brandName = it.brand?.name || it.brand || null;
          raw.brandId = raw.brandName ? raw.brandName.toLowerCase().replace(/\s+/g, "-") : null;
          raw.upc = it.gtin12 || it.upc || null;
          raw.gtin = it.gtin || it.gtin13 || it.gtin14 || null;
          raw.sku = it.sku || it.productID || null;
          raw.listPrice = asNumber(it.msrp || it.listPrice || null);
          raw.price = asNumber(maybePrice);
          raw.priceDrop = raw.price != null ? `$${raw.price}` : null;
          raw.percentOff = computePercentOff(raw.listPrice, raw.price);
          raw.images = pickImage(it.image);
          items.push(raw);
        }
      }
      if (items.length) break;
    }

    // 2) If nothing, use coarse regex fallbacks
    if (!items.length) {
      // Card-ish blocks: data-us-item-id="xxxxx" ... aria-label="Product name" ... "$12.34"
      const cardRegex = /data-us-item-id="([^"]+)"[\s\S]{0,550}?aria-label="([^"]+)"[\s\S]{0,550}?\$([\d,.]+)/gi;
      let m;
      while ((m = cardRegex.exec(html))) {
        const usItemId = m[1];
        const title = m[2];
        const price = asNumber(m[3]);

        const raw = toRawItemBase({ ...storeCtx, adapterId: "walmart" });
        raw.id = usItemId;
        raw.sku = usItemId;
        raw.title = title;
        raw.price = price;
        raw.priceDrop = price != null ? `$${price}` : null;
        items.push(raw);
      }
    }

    // SourceAttribution for HTML mode
    if (items.length) {
      sourceAttribution.attach({
        provider: "weeklyad",
        retailer: "walmart",
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
    // crude pagination heuristic: if we found < ~20 items, assume no more pages
    const nextPage = items.length >= 20 ? page + 1 : null;
    return { items, nextPage, ok: true };
  }

  // ------------------------------- Adapter -----------------------------------

  const adapter = {
    id: () => "walmart",

    canHandle: ({ storeId }) => /walmart/i.test(String(storeId || "")) || /^[0-9]{4,}$/.test(String(storeId || "")),

    /**
     * fetchIndex(ctx, { storeId, zip, page, pageSize })
     * ctx: { http, clock, eventBus, analytics, sourceAttribution }
     */
    async fetchIndex(ctx, { storeId, zip, page = 1, pageSize = 120 }) {
      // Prefer DI from ctx when available
      const httpClient = ctx?.http || http;
      const sat = ctx?.sourceAttribution || sourceAttribution;

      // 1) Resolve store context from zip/storeId
      const resolved = await resolveStoreId(zip, storeId);
      const storeCtx = { ...resolved };

      // 2) Try API first
      let apiRes;
      try {
        apiRes = await fetchApiPage(storeCtx, { page, pageSize });
      } catch (e) {
        apiRes = { ok: false };
      }

      if (apiRes?.ok && apiRes.items?.length) {
        // Stamp SourceAttribution (API)
        sat.attach({
          provider: "weeklyad",
          retailer: "walmart",
          mode: "api",
          storeId: storeCtx.storeId,
          page,
          ts: asISO(clock.now()),
        });
        return { items: apiRes.items, nextPage: apiRes.nextPage ?? null };
      }

      // 3) Fallback to HTML if API fails/empty
      let htmlRes;
      try {
        // use ctx http for HTML
        const origGet = http.get;
        // temporarily bind this adapter's http to ctx' http for HTML
        http.get = httpClient.get.bind(httpClient);
        htmlRes = await fetchHtmlPage(storeCtx, { page });
        http.get = origGet;
      } catch (e) {
        console.warn("[WalmartAdapter] HTML fallback failed", e?.message);
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
import { createWalmartAdapter } from './store-integrations/walmart.js';

const weeklyAd = createStoreWeeklyAdProvider({ http, clock, eventBus, analytics, prefs, db, normalizers, favorites, sourceAttribution, cycleAnalyzer });
weeklyAd.registerAdapter(createWalmartAdapter({ http, clock, sourceAttribution }));

// Then:
const items = await weeklyAd.syncAndRankFor('walmart', { zip: '76106', pageSize: 120 });

Notes:
- Replace placeholder endpoints with your actual Walmart integration.
- The adapter returns RawAdItem[]; StoreWeeklyAdProvider will normalize → rank → favorites flag.
- CycleAnalyzer learning is triggered upstream in StoreWeeklyAdProvider.

----------------------------------------------------------------------------- */
