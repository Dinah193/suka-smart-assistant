/* eslint-disable no-console */
// src/features/scan-compare-trust/services/coupons/providers/store-integrations/kroger.js
// Kroger-family Weekly Ad parser / API adapter for StoreWeeklyAdProvider registry.
// Style: ESM, DI-first, zero external deps, defensive fallbacks.

export function createKrogerAdapter(deps = {}) {
  const http = deps.http || {
    async get() { return { status: 501, data: null }; },
  };
  const clock = deps.clock || { now: () => new Date() };
  const sourceAttribution = deps.sourceAttribution || { attach: () => [] };

  // -------------------- endpoints (DI friendly; replace in app env) ----------
  const endpoints = {
    baseApi:
      deps.baseApi ||
      (typeof import.meta !== "undefined" ? import.meta.env?.VITE_KROGER_API_BASE : null) ||
      "https://api.kroger.example",
    baseHtml:
      deps.baseHtml ||
      (typeof import.meta !== "undefined" ? import.meta.env?.VITE_KROGER_WEB_BASE : null) ||
      "https://www.kroger.com",

    // Weekly ad / featured deals per store (JSON) – placeholders; adjust for real API
    weeklyAdApi: (storeId, page, pageSize) =>
      `${endpoints.baseApi}/v1/stores/${encodeURIComponent(storeId)}/weekly-ad?page=${page}&pageSize=${pageSize}`,

    // Store lookup by ZIP (JSON)
    storeByZipApi: (zip) =>
      `${endpoints.baseApi}/v1/stores/nearby?zip=${encodeURIComponent(zip)}&limit=1`,

    // HTML fallback (store circular landing)
    weeklyAdHtml: (storeId, page) =>
      `${endpoints.baseHtml}/stores/details/${encodeURIComponent(storeId)}?weeklyAdPage=${page}`,
  };

  // ------------------------------- utils ------------------------------------
  const BANNERS = [
    { id: "kroger", re: /kroger/i, name: "Kroger" },
    { id: "ralphs", re: /ralphs/i, name: "Ralphs" },
    { id: "fredmeyer", re: /fred\s*meyer/i, name: "Fred Meyer" },
    { id: "frys", re: /fry'?s|frys/i, name: "Fry's" },
    { id: "smiths", re: /smith'?s|smiths/i, name: "Smith's" },
    { id: "kingsoopers", re: /king\s*soopers/i, name: "King Soopers" },
    { id: "citymarket", re: /city\s*market/i, name: "City Market" },
    { id: "dillons", re: /dillons/i, name: "Dillons" },
    { id: "qfc", re: /\bqfc\b/i, name: "QFC" },
    { id: "picknsave", re: /pick\s*n\s*save/i, name: "Pick 'n Save" },
    { id: "marianos", re: /maria?no'?s/i, name: "Mariano's" },
    { id: "gerbes", re: /gerbes/i, name: "Gerbes" },
    { id: "smithfood", re: /smith'?s food & drug/i, name: "Smith's Food & Drug" },
  ];

  const detectBanner = (storeIdOrName) => {
    const s = String(storeIdOrName || "");
    for (const b of BANNERS) if (b.re.test(s)) return b;
    // default
    return { id: "kroger", name: "Kroger" };
  };

  const asNumber = (v) => {
    if (v == null) return null;
    const n = Number(String(v).replace(/[^\d.-]/g, ""));
    return Number.isFinite(n) ? n : null;
  };

  const asISO = (d) => (d instanceof Date ? d.toISOString() : new Date(d || Date.now()).toISOString());

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
    if (storeId) {
      const banner = detectBanner(storeId);
      return { storeId, storeName: banner.name, region: zip || null, bannerId: banner.id };
    }
    if (!zip) {
      return { storeId: "kroger", storeName: "Kroger", region: null, bannerId: "kroger" };
    }
    try {
      const res = await http.get(endpoints.storeByZipApi(zip));
      if (res.status >= 200 && res.status < 300 && res.data?.stores?.length) {
        const s = res.data.stores[0];
        const name = s.name || s.banner || "Kroger";
        const banner = detectBanner(name);
        return {
          storeId: String(s.id || s.storeId || banner.id),
          storeName: name,
          region: zip,
          bannerId: banner.id,
        };
      }
    } catch (e) {
      console.warn("[KrogerAdapter] resolveStoreContext failed; fallback to Kroger", e?.message);
    }
    return { storeId: "kroger", storeName: "Kroger", region: zip || null, bannerId: "kroger" };
  }

  // --------------------------- API MODE (JSON) -------------------------------
  function mapApiItemToRaw(ai, storeCtx, adapterId) {
    // Kroger-like API commonly exposes withCard / cardPrice / regularPrice etc.
    const title = ai?.title || ai?.name || ai?.headline || "";
    const listPrice = asNumber(ai?.regularPrice ?? ai?.msrp ?? ai?.listPrice);
    const cardPrice = asNumber(ai?.cardPrice ?? ai?.salePrice ?? ai?.promoPrice ?? ai?.price);

    const raw = toRawItemBase({ ...storeCtx, adapterId });
    raw.id = String(ai?.id || ai?.itemId || ai?.sku || title || Math.random());
    raw.title = title;
    raw.brandName = ai?.brand || ai?.brandName || null;
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
    raw.price = cardPrice != null ? cardPrice : asNumber(ai?.price);
    raw.priceDrop = raw.price != null ? `$${raw.price}` : null;
    raw.percentOff = computePercentOff(listPrice, raw.price);
    raw.amountOff = listPrice != null && raw.price != null
      ? `$${(listPrice - raw.price).toFixed(2)}`
      : null;

    // Loyalty
    raw.loyaltyRequired = !!(ai?.withCard || ai?.cardPrice != null || ai?.requiresCard);
    // Windows
    raw.startDate = ai?.startDate || ai?.validFrom || null;
    raw.endDate = ai?.endDate || ai?.validTo || null;

    // Limits & terms
    raw.limitPerCustomer = ai?.limitPerCustomer ?? null;
    raw.limitPerTxn = ai?.limitPerTransaction ?? null;
    raw.terms = ai?.terms || null;
    raw.exclusions = (ai?.exclusions || []).filter(Boolean);

    // Images
    raw.images = pickImages(ai?.images || ai?.image || ai?.imageUrl);

    // SourceAttribution
    sourceAttribution.attach({
      provider: "weeklyad",
      retailer: storeCtx.bannerId || "kroger",
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

    const mapped = arr.map((ai) => mapApiItemToRaw(ai, storeCtx, "kroger"));
    const nextPage =
      typeof res.data?.nextPage === "number"
        ? res.data.nextPage
        : (arr.length >= pageSize ? page + 1 : null);

    return { items: mapped, nextPage, ok: true };
  }

  // ------------------------- HTML MODE (fallback) ----------------------------
  function extractJsonBlocks(html) {
    const blocks = [];
    // Common SSR blobs (illustrative; keep tolerant)
    const ld = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
    let m;
    while ((m = ld.exec(html))) {
      try { blocks.push(JSON.parse(m[1])); } catch {}
    }
    const redux = /__(?:KROGER|APP)__INITIAL_STATE__\s*=\s*({[\s\S]*?});?\s*<\/script>/i;
    const m2 = redux.exec(html);
    if (m2) { try { blocks.push(JSON.parse(m2[1])); } catch {} }
    return blocks;
  }

  function parseHtmlItems(html, storeCtx) {
    const items = [];

    // 1) Parse JSON blobs first
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
          if (!maybeTitle) continue;

          const raw = toRawItemBase({ ...storeCtx, adapterId: "kroger" });
          raw.id = String(it.id || it.sku || it.productID || it.usItemId || maybeTitle);
          raw.title = String(maybeTitle);
          raw.brandName = it.brand?.name || it.brand || null;
          raw.brandId = raw.brandName ? raw.brandName.toLowerCase().replace(/\s+/g, "-") : null;
          raw.upc = it.upc || it.gtin12 || null;
          raw.gtin = it.gtin || it.gtin13 || it.gtin14 || null;
          raw.sku = it.sku || it.productID || null;

          const listPrice = asNumber(it.regularPrice || it.msrp || it.listPrice);
          const cardPrice = asNumber(
            it.cardPrice || it.salePrice || it.promoPrice || it.price || it.offers?.price
          );
          raw.listPrice = listPrice;
          raw.price = cardPrice != null ? cardPrice : asNumber(it.price);
          raw.priceDrop = raw.price != null ? `$${raw.price}` : null;
          raw.percentOff = computePercentOff(listPrice, raw.price);
          raw.loyaltyRequired = !!(it.withCard || it.cardPrice != null || /with\s+card/i.test(String(it?.badge || "")));

          raw.images = pickImages(it.image);
          items.push(raw);
        }
      }
      if (items.length) break;
    }

    // 2) Coarse regex fallback for “with Card” tiles
    if (!items.length) {
      const cardRe = /data-sku="([^"]+)"[\s\S]{0,400}?aria-label="([^"]+)"[\s\S]{0,400}?\$([\d,.]+)[\s\S]{0,200}?(with\s+card)?/gi;
      let m;
      while ((m = cardRe.exec(html))) {
        const sku = m[1];
        const title = m[2];
        const price = asNumber(m[3]);
        const withCard = !!m[4];
        const raw = toRawItemBase({ ...storeCtx, adapterId: "kroger" });
        raw.id = sku;
        raw.sku = sku;
        raw.title = title;
        raw.price = price;
        raw.priceDrop = price != null ? `$${price}` : null;
        raw.loyaltyRequired = withCard;
        items.push(raw);
      }
    }

    if (items.length) {
      sourceAttribution.attach({
        provider: "weeklyad",
        retailer: storeCtx.bannerId || "kroger",
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
    const nextPage = items.length >= 20 ? page + 1 : null; // crude heuristic
    return { items, nextPage, ok: true };
  }

  // ------------------------------- Adapter -----------------------------------
  const adapter = {
    id: () => "kroger", // umbrella id for all banners in the family

    // Accept banner names or numeric store codes as storeId
    canHandle: ({ storeId }) => {
      const s = String(storeId || "");
      if (/^\d{3,}$/.test(s)) return true; // numeric store code
      return BANNERS.some((b) => b.re.test(s));
    },

    /**
     * fetchIndex(ctx, { storeId, zip, page, pageSize })
     * ctx: { http, clock, eventBus, analytics, sourceAttribution }
     */
    async fetchIndex(ctx, { storeId, zip, page = 1, pageSize = 120 }) {
      const httpClient = ctx?.http || http;
      const sat = ctx?.sourceAttribution || sourceAttribution;

      // 1) Resolve store context (banner, name, id)
      const resolved = await resolveStoreContext(zip, storeId);
      const storeCtx = { ...resolved };

      // 2) API first
      let apiRes;
      try {
        apiRes = await fetchApiPage(storeCtx, { page, pageSize });
      } catch (e) {
        apiRes = { ok: false, items: [], nextPage: null };
      }
      if (apiRes?.ok && apiRes.items?.length) {
        sat.attach({
          provider: "weeklyad",
          retailer: storeCtx.bannerId,
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
        // temporarily use ctx http for HTML call
        const orig = http.get;
        http.get = httpClient.get.bind(httpClient);
        htmlRes = await fetchHtmlPage(storeCtx, { page });
        http.get = orig;
      } catch (e) {
        console.warn("[KrogerAdapter] HTML fallback failed", e?.message);
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
import { createKrogerAdapter } from './store-integrations/kroger.js';

const weeklyAd = createStoreWeeklyAdProvider({
  http, clock, eventBus, analytics, prefs, db, normalizers, favorites, sourceAttribution, cycleAnalyzer
});

weeklyAd.registerAdapter(createKrogerAdapter({ http, clock, sourceAttribution }));

// Example:
const ralphsDeals = await weeklyAd.syncAndRankFor('ralphs', { zip: '90036', pageSize: 120 });
const krogerDeals  = await weeklyAd.syncAndRankFor('kroger', { zip: '45202', pageSize: 120 });

// Notes:
// - Replace placeholder endpoints with your actual Kroger-family integration.
// - Adapter returns RawAdItem[]. StoreWeeklyAdProvider will normalize → rank → flag favorites.
// - “with card” prices are flagged via `loyaltyRequired` and propagate to the UI.
// - CycleAnalyzer learning is triggered upstream in StoreWeeklyAdProvider.

----------------------------------------------------------------------------- */
