/* eslint-disable no-console */
// src/features/scan-compare-trust/services/coupons/providers/store-integrations/sams.js
// Sam's Club Weekly Ad / Instant Savings parser • API adapter for StoreWeeklyAdProvider registry.
// Style: ESM, DI-first, zero external deps, defensive fallbacks.

export function createSamsAdapter(deps = {}) {
  const http = deps.http || {
    async get() { return { status: 501, data: null }; },
  };
  const clock = deps.clock || { now: () => new Date() };
  const sourceAttribution = deps.sourceAttribution || { attach: () => [] };

  // -------------------- endpoints (DI friendly; replace in app env) ----------
  const endpoints = {
    baseApi:
      deps.baseApi ||
      (typeof import.meta !== "undefined" ? import.meta.env?.VITE_SAMS_API_BASE : null) ||
      "https://api.samsclub.example",
    baseHtml:
      deps.baseHtml ||
      (typeof import.meta !== "undefined" ? import.meta.env?.VITE_SAMS_WEB_BASE : null) ||
      "https://www.samsclub.com",

    // Weekly ad / Instant Savings per club (JSON) – placeholders; wire to your real API
    weeklyAdApi: (clubId, page, pageSize) =>
      `${endpoints.baseApi}/v1/clubs/${encodeURIComponent(clubId)}/instant-savings?page=${page}&pageSize=${pageSize}`,

    // Club lookup by ZIP (JSON)
    clubByZipApi: (zip) =>
      `${endpoints.baseApi}/v1/clubs/nearby?zip=${encodeURIComponent(zip)}&limit=1`,

    // HTML fallback (Instant Savings landing or weekly ad)
    weeklyAdHtml: (clubId, page) =>
      `${endpoints.baseHtml}/savings/instant-savings?clubId=${encodeURIComponent(clubId)}&page=${page}`,
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
      loyaltyRequired: true,    // membership required at Sam's
      newCustomerOnly: false,
      startDate: null, endDate: null,
      limitPerTxn: null, limitPerCustomer: null, limitPerDay: null,
      exclusions: [], terms: null, images: [],
      adapterId,
      // non-standard hints used upstream in Normalizers/meta panes:
      membership: { required: true, plusOnly: false }, // may toggle per item
      fulfillment: { club: true, curbside: false, shipping: false },
      scanAndGoEligible: null,
    };
  }

  // -------------------------- club resolution --------------------------------
  async function resolveClubContext(zip, clubId) {
    if (clubId) return { storeId: clubId, storeName: "Sam's Club", region: zip || null };
    if (!zip) return { storeId: "sams", storeName: "Sam's Club", region: null };
    try {
      const res = await http.get(endpoints.clubByZipApi(zip));
      if (res.status >= 200 && res.status < 300 && res.data?.clubs?.length) {
        const c = res.data.clubs[0];
        return {
          storeId: String(c.id || c.clubId || "sams"),
          storeName: c.name || "Sam's Club",
          region: zip,
        };
      }
    } catch (e) {
      console.warn("[SamsAdapter] resolveClubContext failed; fallback", e?.message);
    }
    return { storeId: "sams", storeName: "Sam's Club", region: zip || null };
  }

  // --------------------------- API MODE (JSON) -------------------------------
  function mapApiItemToRaw(ai, storeCtx, adapterId) {
    // Typical fields we might see in an Instant Savings/weekly deals API.
    const title = ai?.title || ai?.name || ai?.headline || "";
    const listPrice = asNumber(ai?.listPrice ?? ai?.msrp ?? ai?.regularPrice);
    const price = asNumber(ai?.salePrice ?? ai?.price ?? ai?.memberPrice);

    const raw = toRawItemBase({ ...storeCtx, adapterId });
    raw.id = String(ai?.id || ai?.sku || ai?.itemId || ai?.usItemId || title || Math.random());
    raw.title = title;

    raw.brandName = ai?.brand || ai?.brandName || null;
    raw.brandId = raw.brandName ? raw.brandName.toLowerCase().replace(/\s+/g, "-") : null;

    raw.upc = ai?.upc || null;
    raw.gtin = ai?.gtin || null;
    raw.sku = ai?.sku || ai?.usItemId || null;

    raw.size = ai?.size || ai?.variant || null;
    raw.unit = ai?.unit || ai?.uom || null;
    raw.categoryPath = Array.isArray(ai?.categoryPath)
      ? ai.categoryPath
      : ai?.category
      ? [ai.category]
      : [];

    raw.listPrice = listPrice;
    raw.price = price != null ? price : asNumber(ai?.price);
    raw.priceDrop = raw.price != null ? `$${raw.price}` : null;
    raw.percentOff = computePercentOff(listPrice, raw.price);
    raw.amountOff =
      listPrice != null && raw.price != null ? `$${(listPrice - raw.price).toFixed(2)}` : null;

    // Membership semantics
    const plusOnly = !!(ai?.plusExclusive || ai?.membershipTier === "PLUS");
    raw.membership.plusOnly = plusOnly;
    raw.loyaltyRequired = true;

    // Windows (Instant Savings have explicit start/end)
    raw.startDate = ai?.startDate || ai?.validFrom || null;
    raw.endDate = ai?.endDate || ai?.validTo || null;

    // Limits & terms
    raw.limitPerCustomer = ai?.limitPerMember ?? ai?.limitPerCustomer ?? null;
    raw.limitPerTxn = ai?.limitPerTransaction ?? null;
    raw.terms = ai?.terms || ai?.finePrint || null;
    raw.exclusions = (ai?.exclusions || []).filter(Boolean);

    // Fulfillment / eligibility flags
    raw.fulfillment = {
      club: !!(ai?.clubEligible ?? true),
      curbside: !!ai?.pickupEligible,
      shipping: !!ai?.shippingEligible,
    };
    raw.scanAndGoEligible = !!ai?.scanAndGoEligible; // tie-in for your Scan & Go UX

    raw.images = pickImages(ai?.images || ai?.image || ai?.imageUrl);

    sourceAttribution.attach({
      provider: "weeklyad",
      retailer: "sams",
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

    const mapped = arr.map((ai) => mapApiItemToRaw(ai, storeCtx, "sams"));
    const nextPage =
      typeof res.data?.nextPage === "number"
        ? res.data.nextPage
        : (arr.length >= pageSize ? page + 1 : null);

    return { items: mapped, nextPage, ok: true };
  }

  // ------------------------- HTML MODE (fallback) ----------------------------
  function extractJsonBlocks(html) {
    const blocks = [];
    // JSON-LD blocks
    const ld = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
    let m;
    while ((m = ld.exec(html))) {
      try { blocks.push(JSON.parse(m[1])); } catch {}
    }
    // Inlined bootstrap/Redux state (illustrative key)
    const redux = /__SAMS__INITIAL_STATE__\s*=\s*({[\s\S]*?});?\s*<\/script>/i;
    const m2 = redux.exec(html);
    if (m2) { try { blocks.push(JSON.parse(m2[1])); } catch {} }
    return blocks;
  }

  const pickImagesFromAny = (it) => pickImages(it.image || it.images || it.imageUrl);

  function parseHtmlItems(html, storeCtx) {
    const items = [];

    // 1) Try structured blocks first
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

          const raw = toRawItemBase({ ...storeCtx, adapterId: "sams" });
          raw.id = String(it.id || it.sku || it.productID || it.usItemId || maybeTitle);
          raw.title = String(maybeTitle);
          raw.brandName = it.brand?.name || it.brand || null;
          raw.brandId = raw.brandName ? raw.brandName.toLowerCase().replace(/\s+/g, "-") : null;
          raw.upc = it.upc || it.gtin12 || null;
          raw.gtin = it.gtin || it.gtin13 || it.gtin14 || null;
          raw.sku = it.sku || it.productID || null;

          const listPrice = asNumber(it.msrp || it.listPrice || null);
          const price = asNumber(maybePrice);
          raw.listPrice = listPrice;
          raw.price = price;
          raw.priceDrop = price != null ? `$${price}` : null;
          raw.percentOff = computePercentOff(listPrice, price);

          // crude membership/plus detection from badges/labels
          const labels = [it.badge, it.label, it.promoBadge, it.offerType].join(" ").toLowerCase();
          raw.membership.plusOnly = /plus\s*exclusive|plus\s*member/i.test(labels);

          // fulfillment hints
          raw.fulfillment = {
            club: /club|in-store|in\s*club/i.test(labels) || true,
            curbside: /pickup|curbside/i.test(labels),
            shipping: /ship|delivery/i.test(labels),
          };

          raw.images = pickImagesFromAny(it);
          items.push(raw);
        }
      }
      if (items.length) break;
    }

    // 2) Regex fallback for tiles (sku, title, price, plus badge)
    if (!items.length) {
      const tileRe = /data-sku="([^"]+)"[\s\S]{0,400}?aria-label="([^"]+)"[\s\S]{0,400}?\$([\d,.]+)[\s\S]{0,200}?((?:Plus|PLUS)[^<]{0,30})?/gi;
      let m;
      while ((m = tileRe.exec(html))) {
        const sku = m[1];
        const title = m[2];
        const price = asNumber(m[3]);
        const plusBadge = !!m[4];

        const raw = toRawItemBase({ ...storeCtx, adapterId: "sams" });
        raw.id = sku;
        raw.sku = sku;
        raw.title = title;
        raw.price = price;
        raw.priceDrop = price != null ? `$${price}` : null;
        raw.membership.plusOnly = plusBadge;
        items.push(raw);
      }
    }

    if (items.length) {
      sourceAttribution.attach({
        provider: "weeklyad",
        retailer: "sams",
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
    const nextPage = items.length >= 20 ? page + 1 : null; // heuristic
    return { items, nextPage, ok: true };
  }

  // ------------------------------- Adapter -----------------------------------
  const adapter = {
    id: () => "sams",

    // Accept “sams”, “samsclub” or numeric club codes
    canHandle: ({ storeId }) =>
      /sams|sam's\s*club|samsclub/i.test(String(storeId || "")) || /^\d{3,}$/.test(String(storeId || "")),

    /**
     * fetchIndex(ctx, { storeId, zip, page, pageSize })
     * ctx: { http, clock, eventBus, analytics, sourceAttribution }
     */
    async fetchIndex(ctx, { storeId, zip, page = 1, pageSize = 120 }) {
      const httpClient = ctx?.http || http;
      const sat = ctx?.sourceAttribution || sourceAttribution;

      // 1) Resolve club
      const clubCtx = await resolveClubContext(zip, storeId);

      // 2) API first
      let apiRes;
      try {
        apiRes = await fetchApiPage(clubCtx, { page, pageSize });
      } catch {
        apiRes = { ok: false, items: [], nextPage: null };
      }
      if (apiRes?.ok && apiRes.items?.length) {
        sat.attach({
          provider: "weeklyad",
          retailer: "sams",
          mode: "api",
          storeId: clubCtx.storeId,
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
        htmlRes = await fetchHtmlPage(clubCtx, { page });
        http.get = orig;
      } catch (e) {
        console.warn("[SamsAdapter] HTML fallback failed", e?.message);
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
import { createSamsAdapter } from './store-integrations/sams.js';

const weeklyAd = createStoreWeeklyAdProvider({
  http, clock, eventBus, analytics, prefs, db, normalizers, favorites, sourceAttribution, cycleAnalyzer
});

weeklyAd.registerAdapter(createSamsAdapter({ http, clock, sourceAttribution }));

// Example:
const samsDeals = await weeklyAd.syncAndRankFor('sams', { zip: '76106', pageSize: 120 });

// Notes:
/// - Replace placeholder endpoints with your actual Sam's Club integration.
/// - Adapter returns RawAdItem[]; StoreWeeklyAdProvider will normalize → rank → favorites flag.
/// - Normalizers compute a watchKey (store • brand • sku) so members can favorite **sessions & schedules**.
/// - membership.plusOnly and scanAndGoEligible propagate into meta panes and stacking logic upstream.
/// - CycleAnalyzer learning is triggered upstream in StoreWeeklyAdProvider.

----------------------------------------------------------------------------- */
