/* eslint-disable no-console */
// src/features/scan-compare-trust/services/products/normalize.js
// Single normalized shape for "Scan • Compare • Trust" product pipeline.
// Defensive, dependency-light, ESM/CJS friendly.

/**
 * Canonical product shape used across resolvers, safety checks, pricing, coupons, UI.
 *
 * {
 *   upc: string|null,     // 12-digit UPC (normalized when possible)
 *   ean: string|null,     // raw EAN if provided
 *   gtin: string|null,    // raw GTIN if provided
 *   brand: string|null,
 *   name: string|null,
 *   variant: string|null, // flavor/size string (optional)
 *   sizeQty: number|null, // numeric amount (normalized but not converted)
 *   sizeUnit: "g"|"kg"|"oz"|"lb"|"ml"|"l"|"floz"|"ea",
 *   ingredients: string[], // lowercased, deduped
 *   categories: string[],  // lowercased, deduped
 *   images: string[],      // https URLs preferred, deduped
 *   nutrition: { label?: string|null, facts?: object|null } | null,
 *   warnings: string[],    // "contains: ..", "may contain ..", etc.
 *   offers: [              // list of observed offers from any provider
 *     {
 *       store: string|null,
 *       adapterKey: string|null,
 *       price: number,          // amount in currency (no tax)
 *       currency: string,       // ISO 4217, default "USD"
 *       sizeQty: number|null,   // offer-specific pack size; fallback to product size
 *       sizeUnit: string,       // normalized unit for the offer
 *       promo: boolean,         // true if provider flagged promotion
 *       observedISO: string,    // ISO timestamp
 *       sourceKey: string|null, // originating provider
 *     }
 *   ],
 *   price: {                    // convenience: the chosen "primary" price/offer
 *     amount: number,
 *     currency: string,
 *     store: string|null,
 *     sizeQty: number|null,
 *     sizeUnit: string,
 *     promo: boolean
 *   } | null,
 *   source: { key:string, label?:string, trust?:number, url?:string } | null, // for single-provider usage
 *   sessionId: string|null,     // passthrough tags from Scheduler/SessionRunner
 *   sessionLabel: string|null,
 *   observedISO: string,        // when this normalized snapshot was produced
 *   _attrib?: {                 // optional field-level attribution (provider adapters can fill)
 *     [fieldName: string]: string /* providerKey *\/
 *   }
 * }
 */

(function () {
  /* --------------------------------- utils --------------------------------- */
  const nowISO = () => new Date().toISOString();
  const toStr = (v) => (v == null ? "" : String(v)).trim();
  const lc = (v) => toStr(v).toLowerCase();
  const num = (v) => (v == null || v === "" ? null : Number(v));
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const uniq = (arr) => Array.from(new Set((arr || []).filter(Boolean)));
  const isHttpUrl = (s) => /^https?:\/\//i.test(toStr(s));

  function canonicalUPC(input) {
    const s = String(input || "").replace(/[^0-9]/g, "");
    if (!s) return null;
    if (s.length === 13 && s.startsWith("0")) return s.slice(1); // EAN-13 -> UPC-12
    if (s.length === 12) return s;
    if (s.length === 11) return "0" + s;
    return null; // let caller keep ean/gtin if needed
  }

  // Normalize a unit to canonical short code
  function normUnit(u) {
    const m = lc(u);
    if (["g", "gram", "grams"].includes(m)) return "g";
    if (["kg", "kilogram", "kilograms"].includes(m)) return "kg";
    if (["oz", "ounce", "ounces"].includes(m)) return "oz";
    if (["lb", "lbs", "pound", "pounds"].includes(m)) return "lb";
    if (["ml", "milliliter", "milliliters"].includes(m)) return "ml";
    if (["l", "liter", "litre", "liters", "litres"].includes(m)) return "l";
    if (["floz", "fl oz", "fluid ounce", "fluid ounces"].includes(m)) return "floz";
    if (["ea", "each", "count", "ct", "piece", "pcs"].includes(m)) return "ea";
    return "ea";
  }

  // Try to parse size from strings like "32 oz", "2 lb", "500ml", "12 ct", "1.5L", "4 x 6 oz"
  const SIZE_RX = /(?:(\d+(?:\.\d+)?)\s*[xX]\s*)?(\d+(?:\.\d+)?)\s*(g|kg|oz|lb|ml|l|floz|fl\s?oz|ct|count|each|ea|pcs)/i;
  function parseSizeHint(text) {
    const s = toStr(text);
    const m = s.match(SIZE_RX);
    if (!m) return { qty: null, unit: "ea" };
    const mult = num(m[1]) || 1;
    const qty = num(m[2]);
    let unit = lc(m[3]);
    if (unit === "ct" || unit === "count" || unit === "each" || unit === "pcs") unit = "ea";
    if (unit === "fl oz" || unit === "floz" || unit === "fl oz") unit = "floz";
    return { qty: qty != null ? mult * qty : null, unit: normUnit(unit) };
  }

  function normalizeArray(arr, { lower = true, dedupe = true } = {}) {
    let out = (arr || []).map((v) => (lower ? lc(v) : toStr(v))).filter(Boolean);
    if (dedupe) out = uniq(out);
    return out;
  }

  function normalizeImages(arr) {
    return uniq((arr || [])
      .map((u) => toStr(u))
      .filter((s) => s && isHttpUrl(s)));
  }

  /* ------------------------------ shape helpers ---------------------------- */
  function emptyProduct() {
    return {
      upc: null, ean: null, gtin: null,
      brand: null, name: null, variant: null,
      sizeQty: null, sizeUnit: "ea",
      ingredients: [], categories: [], images: [],
      nutrition: null, warnings: [],
      offers: [],
      price: null,
      source: null,
      sessionId: null,
      sessionLabel: null,
      observedISO: nowISO(),
      _attrib: undefined,
    };
  }

  // Build a normalized offer
  function toOffer(o, fallbacks = {}, sourceKey = null) {
    const offer = {
      store: toStr(o?.store) || toStr(fallbacks.store) || null,
      adapterKey: toStr(o?.adapterKey) || toStr(fallbacks.adapterKey) || null,
      price: num(o?.price ?? o?.amount),
      currency: toStr(o?.currency) || "USD",
      sizeQty: num(o?.sizeQty ?? fallbacks.sizeQty) || null,
      sizeUnit: normUnit(o?.sizeUnit ?? fallbacks.sizeUnit) || "ea",
      promo: !!(o?.promo ?? o?.isPromo),
      observedISO: toStr(o?.observedISO) || nowISO(),
      sourceKey: sourceKey,
    };
    // discard invalid
    if (!Number.isFinite(offer.price)) return null;
    return offer;
  }

  /* --------------------------------- quality -------------------------------- */
  /**
   * Simple quality heuristic: 0..1
   * - trust weight (0..1)
   * - text length bonus for brand/name (0..0.3)
   * - numeric sanity for sizeQty (+0.2)
   */
  function scoreQuality(fieldName, value, trust = 0.6) {
    if (value == null || value === "") return 0;
    let s = clamp(Number(trust) || 0, 0, 1);
    if (typeof value === "string") s += clamp(value.length / 60, 0, 0.3);
    if (fieldName === "sizeQty" && Number.isFinite(Number(value))) s += 0.2;
    return clamp(s, 0, 1);
  }

  /* --------------------------------- validator ------------------------------ */
  function validateProductShape(p) {
    const errs = [];
    if (p.upc && !/^\d{12}$/.test(p.upc)) errs.push("upc must be 12 digits if present.");
    if (p.price && typeof p.price.amount !== "number") errs.push("price.amount must be numeric.");
    (p.offers || []).forEach((o, i) => {
      if (typeof o.price !== "number") errs.push(`offers[${i}].price must be numeric.`);
    });
    return errs;
  }

  /* ------------------------- public normalization API ---------------------- */
  /**
   * normalizeFromProvider(providerKey, input, meta?)
   *
   * @param {string} providerKey - e.g., "walmart", "samsclub"
   * @param {object} input - provider-shaped object; we'll map fields heuristically
   *  Accepts any of:
   *   - input.upc|ean|gtin
   *   - input.brand, input.name, input.title
   *   - input.variant|flavor|subtitle
   *   - input.sizeQty|sizeUnit|size|package|title (size hint)
   *   - input.ingredients (string[]|string), input.categories (string[]|string)
   *   - input.images (string[])
   *   - input.nutrition { label?, facts? }
   *   - input.warnings (string[])
   *   - input.offers or input.price
   * @param {object} meta - { trust?:0..1, label?:string, url?:string, sessionId?, sessionLabel? }
   * @returns {object} normalized product shape
   */
  function normalizeFromProvider(providerKey, input = {}, meta = {}) {
    const out = emptyProduct();

    // ids
    out.upc = canonicalUPC(input.upc || input.gtin || input.ean);
    out.ean = toStr(input.ean) || (out.upc ? null : null);
    out.gtin = toStr(input.gtin) || (out.upc ? null : null);

    // names
    const brand = input.brand || input.mfgr || input.manufacturer || null;
    const name = input.name || input.title || input.productName || null;
    const variant = input.variant || input.flavor || input.subtitle || null;

    out.brand = brand ? toStr(brand) : null;
    out.name = name ? toStr(name) : (out.brand || variant ? toStr([out.brand, variant].filter(Boolean).join(" ")) : null);
    out.variant = variant ? toStr(variant) : null;

    // size
    let sizeQty = num(input.sizeQty);
    let sizeUnit = input.sizeUnit ? normUnit(input.sizeUnit) : "ea";
    if (sizeQty == null) {
      const hint = parseSizeHint(input.size || input.package || input.title || input.name || "");
      sizeQty = hint.qty;
      sizeUnit = hint.unit || sizeUnit;
    }
    out.sizeQty = sizeQty;
    out.sizeUnit = sizeUnit;

    // ingredients / categories / images / warnings
    if (Array.isArray(input.ingredients)) {
      out.ingredients = normalizeArray(input.ingredients, { lower: true });
    } else if (typeof input.ingredients === "string") {
      out.ingredients = normalizeArray(input.ingredients.split(/[;,]/g), { lower: true });
    }

    out.categories = normalizeArray(input.categories, { lower: true });
    out.images = normalizeImages(input.images);
    out.warnings = normalizeArray(input.warnings, { lower: true });

    // nutrition
    const nutrition = input.nutrition || null;
    if (nutrition) {
      const label = toStr(nutrition.label || "");
      const facts = nutrition.facts || null;
      out.nutrition = { label: label || null, facts: facts || null };
    }

    // offers / price
    const sourceKey = toStr(providerKey) || null;
    const offerFallbacks = { sizeQty: out.sizeQty, sizeUnit: out.sizeUnit };
    const offersIn = Array.isArray(input.offers) ? input.offers : (input.price ? [input.price] : []);
    out.offers = offersIn
      .map((o) => toOffer(o, offerFallbacks, sourceKey))
      .filter(Boolean);

    // choose a primary price: lowest numeric price
    if (out.offers.length) {
      const best = out.offers.filter((o) => Number.isFinite(o.price)).sort((a, b) => a.price - b.price)[0];
      if (best) {
        out.price = {
          amount: best.price,
          currency: best.currency,
          store: best.store,
          sizeQty: best.sizeQty,
          sizeUnit: best.sizeUnit,
          promo: !!best.promo,
        };
      }
    }

    // source & session tags
    out.source = sourceKey ? { key: sourceKey, label: toStr(meta.label) || sourceKey, trust: meta.trust ?? 0.6, url: toStr(meta.url) || undefined } : null;
    out.sessionId = toStr(meta.sessionId) || null;
    out.sessionLabel = toStr(meta.sessionLabel) || null;
    out.observedISO = nowISO();

    // optional field-level attribution (provider filled fields get marked)
    const attrib = {};
    if (out.brand) attrib.brand = sourceKey;
    if (out.name) attrib.name = sourceKey;
    if (out.variant) attrib.variant = sourceKey;
    if (out.sizeQty != null) attrib.sizeQty = sourceKey;
    if (out.sizeUnit) attrib.sizeUnit = sourceKey;
    if (out.ingredients?.length) attrib.ingredients = sourceKey;
    if (out.categories?.length) attrib.categories = sourceKey;
    if (out.images?.length) attrib.images = sourceKey;
    if (out.price) attrib.price = sourceKey;
    if (out.offers?.length) attrib.offers = sourceKey;
    out._attrib = Object.keys(attrib).length ? attrib : undefined;

    // final validation (non-throwing)
    const errs = validateProductShape(out);
    if (errs.length) {
      // Keep non-fatal; log in dev only
      if (typeof process !== "undefined" && process.env && process.env.NODE_ENV !== "production") {
        console.warn("[normalize] shape warnings:", errs);
      }
    }

    return out;
  }

  /* ------------------------------ exports ---------------------------------- */
  const PRODUCT_SHAPE = Object.freeze({
    upc: "string|null (12-digit when present)",
    ean: "string|null",
    gtin: "string|null",
    brand: "string|null",
    name: "string|null",
    variant: "string|null",
    sizeQty: "number|null",
    sizeUnit: '"g"|"kg"|"oz"|"lb"|"ml"|"l"|"floz"|"ea"',
    ingredients: "string[] (lowercased, deduped)",
    categories: "string[] (lowercased, deduped)",
    images: "string[] (http/https URLs, deduped)",
    nutrition: "{ label?:string|null, facts?:object|null } | null",
    warnings: "string[]",
    offers: "[{ store, adapterKey, price:number, currency, sizeQty?, sizeUnit, promo:boolean, observedISO, sourceKey }]",
    price: "{ amount:number, currency, store?, sizeQty?, sizeUnit, promo } | null",
    source: "{ key:string, label?:string, trust?:number, url?:string } | null",
    sessionId: "string|null",
    sessionLabel: "string|null",
    observedISO: "string (ISO timestamp)",
    _attrib: "{ [fieldName]: providerKey } | undefined",
  });

  // CommonJS + ESM friendly export
  const api = {
    PRODUCT_SHAPE,
    normalizeFromProvider,
    emptyProduct,
    scoreQuality,
    // exposing helpers is handy for provider adapters:
    __helpers: {
      canonicalUPC,
      normUnit,
      parseSizeHint,
      normalizeArray,
      normalizeImages,
      toOffer,
      validateProductShape,
    },
  };

  try { module.exports = api; } catch (_e) {}
  try { (globalThis || window).ProductNormalize = api; } catch (_e) {}
})();
