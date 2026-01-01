/* eslint-disable no-console */
// src/features/scan-compare-trust/services/coupons/providers/store-integrations/costco.js
// Costco Weekly Ad / Member-Only Savings — parser + API adapter
// Style: ESM-first, dependency-light, optional deps via DI, safe fallbacks.

/**
 * Factory with optional dependency injection.
 *
 * @param {Object} deps
 *  - fetch:        (url, opts) => Promise<Response>                 // defaults to global fetch
 *  - cache:        { get(key), set(key, val, {ttl}) }               // optional
 *  - eventBus:     { emit(evt, payload):void }                      // optional
 *  - analytics:    { track(evt, payload):void }                     // optional
 *  - log:          { info, warn, error, debug }                     // optional
 *  - cheerio:      cheerio module                                   // optional; lazy imported if absent
 *  - pdf:          { parseArrayBufferToText: (ArrayBuffer)=>string }// optional; only used for PDF fallback
 *  - config:       { get(path, fb):any }                            // optional; for endpoints and TTLs
 *  - userPrefs:    { getMembershipId('costco'):string?,
 *                    isFavoriteBrand:(brand:string)=>boolean }      // optional
 *  - ids:          { uid:()=>string }                               // optional; for deterministic IDs
 *
 * @returns {Object} adapter
 */
export function createCostcoAdapter(deps = {}) {
  const fetcher = deps.fetch || (typeof fetch !== "undefined" ? fetch : null);
  if (!fetcher) throw new Error("[costco] fetch is required in this runtime");

  const log = deps.log || console;
  const cache = deps.cache || null;
  const bus = deps.eventBus || null;
  const analytics = deps.analytics || null;
  const cfg = deps.config || { get: (_p, fb) => fb };

  // Configurable endpoints & behavior (override via config.get)
  const ENDPOINTS = {
    // Public marketing pages often include a JSON blob we can parse
    // Fallback to region-specific pages if needed.
    adIndex: cfg.get(
      "providers.costco.endpoints.adIndex",
      "https://www.costco.com/member-only-savings.html"
    ),
    // Club locator (zip->clubs), used to tailor ad availability windows
    locator: cfg.get(
      "providers.costco.endpoints.locator",
      "https://www.costco.com/api/warehouseLookup/v1/warehouses?postalCode={ZIP}&distance=50"
    ),
    // Sometimes product JSON lives behind this pattern during promo periods:
    // We'll try + gracefully fallback to HTML/PDF scrapes.
    promoJson: cfg.get(
      "providers.costco.endpoints.promoJson",
      "https://www.costco.com/mos-api/promo/v1/promos?country=US"
    ),
  };

  const TTL = {
    ad: cfg.get("providers.costco.ttl.ad", 60 * 60), // 1h
    locator: cfg.get("providers.costco.ttl.locator", 24 * 60 * 60), // 24h
  };

  // Helper: safe JSON
  const safeJson = async (res) => {
    const txt = await res.text();
    try {
      return JSON.parse(txt);
    } catch {
      return { _raw: txt };
    }
  };

  /** Normalize into platform Coupon schema */
  function normalizeOffer(raw, context = {}) {
    // raw is a mixture from JSON/HTML/PDF sources
    const {
      id,
      sku,
      upc,
      brand,
      name,
      description,
      category,
      image,
      price,
      discount,
      savingsType,
      terms,
      startISO,
      endISO,
      clubIds,
      online,
      limits,
      source = "costco",
      sourceUrl,
    } = raw;

    const favorite = deps.userPrefs?.isFavoriteBrand
      ? !!deps.userPrefs.isFavoriteBrand(brand || "")
      : false;

    // ID strategy: prefer stable IDs; fallback to a namespaced hash
    const stableId =
      id ||
      (deps.ids?.uid
        ? `costco_${deps.ids.uid()}`
        : `costco_${(brand || "item")
            .toLowerCase()
            .replace(/\W+/g, "-")
            .slice(0, 40)}_${(sku || upc || Math.random().toString(36).slice(2, 9))}`);

    // Stacking at Costco: member-only savings typically behave like "instant savings" at register.
    // Expose conservative defaults and let Rule Engine finalize.
    const stacking = {
      combinable: false,
      withManufacturer: false,
      withStore: false,
      notes: "Costco member-only instant savings; stacking typically restricted.",
    };

    return {
      id: stableId,
      provider: "costco",
      channel: online ? "online" : "in-store",
      clubIds: clubIds || (context.clubId ? [context.clubId] : []),
      brand: brand || null,
      name: name || description || "Costco Offer",
      description: description || terms || null,
      category: category || null,
      image: image || null,
      sku: sku || null,
      upc: upc || null,
      price: price || null,
      discount: discount || null, // {type:'amount'|'percent'|'bogo', value:number, currency:'USD'}
      savingsType: savingsType || "instant",
      terms: terms || null,
      startISO: startISO || context.window?.startISO || null,
      endISO: endISO || context.window?.endISO || null,
      source,
      sourceUrl: sourceUrl || context.sourceUrl || ENDPOINTS.adIndex,
      stacking,
      flags: {
        membershipRequired: true,
        favoriteBrand: favorite,
      },
      // Hints for your CycleAnalyzer (brand/store cadence learning)
      cadence: {
        storeId: "costco",
        brand: brand || null,
        category: category || null,
        // Adapter hints; the analyzer will refine with observed history
        likelyCycleDays: 28, // Costco tends to run ~3–4 week cycles for MOS
      },
      // For SourceAttribution
      _meta: {
        parser: "costco-adapter@1.0.0",
        extraction: raw._extraction || "json|html|pdf",
      },
    };
  }

  /** HTML parser: attempts to extract embedded JSON or card grids */
  async function parseHtmlAd(html, context) {
    // Prefer cheerio when available; fallback to naive DOM parsing
    const cheerio = deps.cheerio || (await tryImportCheerio());
    if (!cheerio) return [];

    const $ = cheerio.load(html);

    // 1) Look for JSON blobs in <script> tags
    const offersFromJson = [];
    $("script").each((_, el) => {
      const txt = $(el).html() || "";
      const looksJson =
        txt.includes("promo") ||
        txt.includes("offers") ||
        txt.includes('"promotion"') ||
        txt.trim().startsWith("{") ||
        txt.trim().startsWith("[");
      if (!looksJson) return;
      try {
        const parsed = JSON.parse(sanitizeJson(txt));
        const extracted = extractOffersFromUnknownJson(parsed, { sourceUrl: context.sourceUrl });
        offersFromJson.push(...extracted);
      } catch {
        // ignore non-JSON script tags
      }
    });

    // 2) Fallback: parse visible card grids (very defensive)
    const offersFromCards = [];
    $('[class*="card"], [class*="promo"], [class*="offer"]').each((_, el) => {
      const node = $(el);
      const name = textClean(node.find("h2, h3, .title, .name").first().text());
      const brand = textClean(node.find(".brand").first().text());
      const desc =
        textClean(node.find(".desc, .description").first().text()) ||
        textClean(node.find("p").first().text());
      const priceTxt =
        textClean(node.find(".price, [class*='price']").first().text()) || null;
      const img =
        node.find("img").attr("src") ||
        node.find("img").attr("data-src") ||
        null;
      const discountTxt =
        textClean(node.find(".savings, .discount").first().text()) || null;

      if (!name && !desc && !discountTxt) return;

      const discount = parseDiscount(discountTxt, priceTxt);
      offersFromCards.push(
        normalizeOffer(
          {
            brand,
            name,
            description: desc,
            image: img,
            discount,
            _extraction: "html-cards",
          },
          context
        )
      );
    });

    return dedupeOffers([...offersFromJson.map((o) => normalizeOffer(o, context)), ...offersFromCards]);
  }

  /** JSON parser for known endpoints */
  function parseJsonAd(json, context) {
    const offers = extractOffersFromUnknownJson(json, { sourceUrl: context.sourceUrl });
    return dedupeOffers(offers.map((o) => normalizeOffer(o, context)));
  }

  /** PDF parser — light stub: uses optional deps.pdf to extract text, then regex scan */
  async function parsePdfAd(arrayBuffer, context) {
    if (!deps.pdf?.parseArrayBufferToText) {
      log.warn("[costco] PDF parsing unavailable (deps.pdf missing).");
      return [];
    }
    const text = await deps.pdf.parseArrayBufferToText(arrayBuffer);
    // Heuristic: find "$X OFF", "save $X", dates, and product lines
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

    const window = guessWindow(lines) || context.window;
    const results = [];
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      const disc = parseDiscount(l);
      if (!disc) continue;
      const next = lines[i + 1] || "";
      const maybeBrand = /^[A-Z0-9 \-]{3,}$/.test(next) ? next : null;
      results.push(
        normalizeOffer(
          {
            brand: maybeBrand,
            name: maybeBrand ? `${maybeBrand} — Offer` : "Costco Offer",
            description: maybeBrand ? `Member-only savings for ${maybeBrand}` : "Member-only savings",
            discount: disc,
            _extraction: "pdf",
            startISO: window?.startISO,
            endISO: window?.endISO,
          },
          context
        )
      );
    }
    return dedupeOffers(results);
  }

  /** Public: fetch Costco ad and return normalized offers */
  async function fetchWeeklyAd(params = {}) {
    const { zip = null, clubId = null, force = false } = params;
    // Cache key considers club/zip to allow localized windows if needed
    const ckey = `costco:ad:${clubId || zip || "national"}`;
    if (!force && cache) {
      const cached = await cache.get(ckey);
      if (cached) return cached;
    }

    const context = { sourceUrl: ENDPOINTS.adIndex, clubId: clubId || null };

    // Try JSON endpoint first
    let offers = [];
    try {
      const url = ENDPOINTS.promoJson;
      const res = await fetcher(url, { headers: browserHeaders() });
      if (res.ok) {
        const json = await safeJson(res);
        const parsed = parseJsonAd(json, context);
        if (parsed?.length) offers = parsed;
      }
    } catch (e) {
      log.debug?.("[costco] promoJson fetch failed", e);
    }

    // Fallback: parse marketing HTML
    if (!offers.length) {
      try {
        const res = await fetcher(ENDPOINTS.adIndex, { headers: browserHeaders() });
        if (res.ok) {
          const html = await res.text();
          const win = extractWindowFromHtml(html) || (zip || clubId ? await getWindowByClub(zip, clubId) : null);
          const parsed = await parseHtmlAd(html, { ...context, window: win });
          if (parsed?.length) offers = parsed;
        }
      } catch (e) {
        log.debug?.("[costco] adIndex fetch/parse failed", e);
      }
    }

    // Fallback: PDF (some cycles publish a booklet PDF)
    if (!offers.length) {
      try {
        const pdfUrl = tryFindPdfUrlFromMarketing(context.sourceUrl);
        if (pdfUrl) {
          const res = await fetcher(pdfUrl, { headers: browserHeaders() });
          if (res.ok) {
            const buf = await res.arrayBuffer();
            const win = await getWindowByClub(zip, clubId);
            const parsed = await parsePdfAd(buf, { ...context, window: win });
            if (parsed?.length) offers = parsed;
          }
        }
      } catch (e) {
        log.debug?.("[costco] pdf parse failed", e);
      }
    }

    // Emit learning signals & track
    if (offers.length) {
      bus?.emit("coupon:provider:pull:complete", {
        provider: "costco",
        count: offers.length,
        clubId: clubId || null,
        zip: zip || null,
        atISO: new Date().toISOString(),
      });
      analytics?.track?.("coupon_provider_pull", {
        provider: "costco",
        count: offers.length,
      });

      // Kick CycleAnalyzer hints
      offers.forEach((o) =>
        bus?.emit("coupon:offer:observed", {
          provider: "costco",
          brand: o.brand,
          category: o.category,
          startISO: o.startISO,
          endISO: o.endISO,
          atISO: new Date().toISOString(),
        })
      );
    }

    if (cache) await cache.set(ckey, offers, { ttl: TTL.ad });
    return offers;
  }

  /** Optional: find offers by SKU or keyword in the current cycle */
  async function findOffersBySku(query, params = {}) {
    const all = await fetchWeeklyAd(params);
    const q = String(query || "").toLowerCase();
    return all.filter((o) => {
      return (
        (o.sku && String(o.sku).toLowerCase().includes(q)) ||
        (o.upc && String(o.upc).toLowerCase().includes(q)) ||
        (o.name && o.name.toLowerCase().includes(q)) ||
        (o.brand && o.brand.toLowerCase().includes(q)) ||
        (o.description && o.description.toLowerCase().includes(q))
      );
    });
  }

  /** Optional: map zip -> clubs (warehouse IDs) */
  async function fetchClubMap(zip) {
    if (!zip) return [];
    const ckey = `costco:clubs:${zip}`;
    if (cache) {
      const cached = await cache.get(ckey);
      if (cached) return cached;
    }
    const url = ENDPOINTS.locator.replace("{ZIP}", encodeURIComponent(zip));
    try {
      const res = await fetcher(url, { headers: browserHeaders() });
      if (!res.ok) return [];
      const json = await safeJson(res);
      const clubs = Array.isArray(json?.warehouses) ? json.warehouses : json;
      const mapped =
        (clubs || []).map((w) => ({
          id: String(w?.warehouseNumber || w?.id || ""),
          name: w?.name || w?.address?.city || "Costco Warehouse",
          city: w?.address?.city || null,
          state: w?.address?.state || null,
          zip: w?.address?.zip || null,
          hours: w?.hours || null,
        })) || [];
      if (cache) await cache.set(ckey, mapped, { ttl: TTL.locator });
      return mapped;
    } catch (e) {
      log.debug?.("[costco] locator failed", e);
      return [];
    }
  }

  /** Healthcheck: quick probe */
  async function healthcheck() {
    try {
      const res = await fetcher(ENDPOINTS.adIndex, { method: "HEAD" });
      return res.ok ? { ok: true } : { ok: false, status: res.status };
    } catch (e) {
      return { ok: false, error: String(e?.message || e) };
    }
  }

  // ------- Helpers -------

  function browserHeaders() {
    return {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
      Accept: "text/html,application/json;q=0.9,*/*;q=0.8",
    };
  }

  async function tryImportCheerio() {
    try {
      // If deps.cheerio not provided, attempt dynamic import in Node
      if (typeof window !== "undefined") return null;
      const mod = await import("cheerio");
      return mod.default || mod;
    } catch {
      return null;
    }
  }

  function sanitizeJson(txt) {
    // Attempt to extract JSON object/array from noisy <script> contents
    const startObj = txt.indexOf("{");
    const startArr = txt.indexOf("[");
    const start =
      startObj === -1 ? startArr : startArr === -1 ? startObj : Math.min(startObj, startArr);
    const endObj = txt.lastIndexOf("}");
    const endArr = txt.lastIndexOf("]");
    const end =
      endObj === -1 ? endArr : endArr === -1 ? endObj : Math.max(endObj, endArr);
    if (start >= 0 && end >= 0 && end > start) {
      return txt.slice(start, end + 1);
    }
    return txt;
  }

  function textClean(s) {
    return (s || "").replace(/\s+/g, " ").trim();
  }

  function parseDiscount(discountText, priceText) {
    const s = `${discountText || ""} ${priceText || ""}`.toLowerCase();
    if (!s || s.length < 2) return null;

    // $X OFF
    const amt = s.match(/\$ ?(\d+(?:\.\d{1,2})?)/);
    if (s.includes("off") && amt) {
      return { type: "amount", value: parseFloat(amt[1]), currency: "USD" };
    }

    // X% OFF
    const pct = s.match(/(\d{1,2})\s?%/);
    if (pct && s.includes("%")) {
      return { type: "percent", value: Number(pct[1]) };
    }

    // BOGO styles
    if (/\bbogo\b|\bbuy one get one\b/.test(s)) {
      return { type: "bogo", value: 1 };
    }

    return null;
  }

  function dedupeOffers(list) {
    const seen = new Set();
    const out = [];
    for (const o of list) {
      const key =
        (o.brand || "") +
        "|" +
        (o.name || "") +
        "|" +
        (o.discount?.type || "") +
        "|" +
        (o.startISO || "") +
        "|" +
        (o.endISO || "");
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(o);
    }
    return out;
  }

  function extractWindowFromHtml(html) {
    // Look for date ranges like "Valid MM/DD – MM/DD/YYYY"
    const m = html.match(
      /(valid|savings)\s*(?:through|from)?\s*([a-z]{3,9}\s+\d{1,2},?\s*\d{4}|\d{1,2}\/\d{1,2}\/\d{2,4})\s*[-–]\s*([a-z]{3,9}\s+\d{1,2},?\s*\d{4}|\d{1,2}\/\d{1,2}\/\d{2,4})/i
    );
    if (!m) return null;
    const startISO = toISODate(m[2]);
    const endISO = toISODate(m[3]);
    if (!startISO || !endISO) return null;
    return { startISO, endISO };
  }

  async function getWindowByClub(zip, clubId) {
    // If needed, could refine based on club merchandising calendars
    // For now, return null and let normalizers fall back to null or analyzer fill in.
    if (!zip && !clubId) return null;
    // Stretch goal: sometimes MOS PDF lists explicit dates; already handled elsewhere.
    return null;
  }

  function toISODate(s) {
    if (!s) return null;
    // Try MM/DD/YYYY or Month DD, YYYY
    const d = new Date(s);
    if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
    const mdy = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
    if (mdy) {
      const [_, m, d2, y] = mdy;
      const year = Number(y.length === 2 ? `20${y}` : y);
      const dt = new Date(year, Number(m) - 1, Number(d2));
      if (!isNaN(dt.getTime())) return dt.toISOString().slice(0, 10);
    }
    return null;
    }

  function extractOffersFromUnknownJson(json, { sourceUrl }) {
    const out = [];
    // Common shapes we’ve seen: {promos:[{headline,copy,media,dates,...}]}
    const candidates = [];
    if (Array.isArray(json)) candidates.push(...json);
    if (json?.promos && Array.isArray(json.promos)) candidates.push(...json.promos);
    if (json?.offers && Array.isArray(json.offers)) candidates.push(...json.offers);
    if (json?.data?.promotions) candidates.push(...json.data.promotions);
    if (!candidates.length) return out;

    for (const p of candidates) {
      const name = p.name || p.headline || p.title || null;
      const brand = p.brand || guessBrandFromName(name);
      const desc =
        p.description || p.copy || p.body || p.subtitle || p.shortDescription || null;
      const image =
        p.image?.url ||
        p.media?.image?.src ||
        p.media?.[0]?.url ||
        p.heroImage?.url ||
        null;
      const sku = p.sku || p.itemNumber || p.skuId || null;
      const upc = p.upc || null;
      const category = p.category || p.department || null;
      const terms = p.legal || p.terms || null;

      const startISO = toISODate(p.startDate || p.start || p.activeFrom || p.validFrom);
      const endISO = toISODate(p.endDate || p.end || p.activeTo || p.validTo);

      const discount = normalizeDiscountFromJson(p);
      const online = !!(p.onlineOnly || p.webOnly || p.channel === "online");
      const clubIds = p.clubIds || null;

      out.push({
        id: p.id || p.promoId || p.offerId || null,
        brand,
        name,
        description: desc,
        image,
        sku,
        upc,
        category,
        terms,
        startISO,
        endISO,
        discount,
        online,
        clubIds,
        sourceUrl,
        _extraction: "json",
      });
    }
    return out;
  }

  function normalizeDiscountFromJson(p) {
    // Attempt to interpret common fields
    if (p.amountOff || p.priceOff) {
      const val = Number(p.amountOff || p.priceOff);
      if (!isNaN(val)) return { type: "amount", value: val, currency: "USD" };
    }
    if (p.percentOff || p.percentageOff) {
      const val = Number(p.percentOff || p.percentageOff);
      if (!isNaN(val)) return { type: "percent", value: val };
    }
    if (p.bogo || /bogo/i.test(p.promoType || "")) {
      return { type: "bogo", value: 1 };
    }
    const txt =
      (p.discountText ||
        p.badgeText ||
        p.headline ||
        p.copy ||
        p.description ||
        "") + "";
    return parseDiscount(txt, p.priceText || "");
  }

  function guessBrandFromName(name) {
    if (!name) return null;
    // Heuristic: first token up to ™/®/—/–/-
    const t = name.split(/[™®\-–—]/)[0].trim();
    // Avoid generic starters
    if (/^save|member|only|instant|warehouse|coupon/i.test(t)) return null;
    if (t.length < 3 || t.length > 40) return null;
    return t;
  }

  function guessWindow(lines) {
    const joined = lines.join(" ");
    return extractWindowFromHtml(joined);
  }

  function tryFindPdfUrlFromMarketing(_sourceUrl) {
    // Heuristic; your upstream orchestrator can pass a discovered PDF URL via config later.
    return null;
  }

  // Public API
  return {
    id: "costco",
    fetchWeeklyAd,
    fetchClubMap,
    findOffersBySku,
    healthcheck,
  };
}
