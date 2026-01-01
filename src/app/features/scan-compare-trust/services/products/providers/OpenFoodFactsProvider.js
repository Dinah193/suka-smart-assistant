/* eslint-disable no-console */
// src/features/scan-compare-trust/services/products/providers/OpenFoodFactsProvider.js
// Food UPC/EAN → product via OpenFoodFacts (world api). Dependency-light, ESM/CJS friendly.

(function () {
  /* -------------------------------- safe imports -------------------------------- */
  var normalize = null;
  try {
    normalize = require("../normalize.js"); // { normalizeFromProvider }
    normalize = normalize.default || normalize;
  } catch (_e) {}

  var eventBus = { emit(){}, on(){}, off(){} };
  try {
    var eb = require("@/services/eventBus");
    eventBus = (eb?.default || eb?.eventBus || eb) || eventBus;
  } catch (_e) {}

  var ProductResolver = null;
  try {
    ProductResolver = require("../ProductResolver.js");
    ProductResolver = ProductResolver.default || ProductResolver;
  } catch (_e) {}

  /* ---------------------------------- utils ----------------------------------- */
  var toStr = (v)=> (v==null?"":String(v)).trim();
  var lc   = (v)=> toStr(v).toLowerCase();
  var nowISO = ()=> new Date().toISOString();
  var sleep = (ms)=> new Promise(r=>setTimeout(r, ms));

  function canonicalBarcode(input) {
    const s = String(input || "").replace(/[^0-9]/g, "");
    if (!s) return null;
    // OFF accepts EAN-13 & UPC-12; if 11, pad; if 13 beginning with 0, both forms may work.
    if (s.length === 11) return "0"+s;
    if (s.length === 12 || s.length === 13 || s.length === 8 || s.length === 14) return s;
    return null;
  }

  // Pick best image url from OFF
  function bestImage(p) {
    const main = p?.image_url || p?.image_front_url || p?.image_small_url || null;
    const arr = [];
    if (main) arr.push(main);
    if (p?.selected_images) {
      const si = p.selected_images;
      for (const k of ["front","ingredients","nutrition"]) {
        const m = si[k]?.display?.en || si[k]?.display?.["en"] || si[k]?.display?.[""] || null;
        if (m) arr.push(m);
      }
    }
    return Array.from(new Set(arr.filter(Boolean)));
  }

  function parseIngredients(p) {
    if (Array.isArray(p?.ingredients) && p.ingredients.length) {
      return p.ingredients.map(i => lc(i.text || i.id || i.origin || i.percent_estimate || i)).filter(Boolean);
    }
    if (toStr(p?.ingredients_text)) {
      // OFF sometimes uses commas/semicolons
      return toStr(p.ingredients_text).split(/[;,]/g).map(lc).filter(Boolean);
    }
    return [];
  }

  function parseWarnings(p) {
    const out = [];
    // allergens_tags like ["en:milk","en:peanuts"]
    if (Array.isArray(p?.allergens_tags)) {
      for (const t of p.allergens_tags) {
        const tag = lc(t).replace(/^en:/, "");
        if (tag) out.push("contains: " + tag);
      }
    }
    // traces_tags e.g., "en:nuts" -> may contain nuts
    if (Array.isArray(p?.traces_tags)) {
      for (const t of p.traces_tags) {
        const tag = lc(t).replace(/^en:/, "");
        if (tag) out.push("may contain: " + tag);
      }
    }
    // additives_tags e.g., "en:e621" (MSG)
    if (Array.isArray(p?.additives_tags)) {
      for (const t of p.additives_tags) out.push("additive: " + lc(t).replace(/^en:/, ""));
    }
    return Array.from(new Set(out));
  }

  function parseCategories(p) {
    // categories_tags like ["en:breakfast-cereals","en:ready-to-eat-cereals"]
    const t = Array.isArray(p?.categories_tags) ? p.categories_tags : [];
    const human = toStr(p?.categories || "");
    const out = t.map(s => lc(s).replace(/^en:/,""));
    if (human) {
      human.split(/[>,]/g).forEach(x => { const v = lc(x); if (v) out.push(v); });
    }
    return Array.from(new Set(out));
  }

  function parseNutrition(p) {
    const label = p?.nutriscore_grade ? ("nutri-score: " + String(p.nutriscore_grade).toUpperCase()) : null;
    const facts = p?.nutriments || null;
    if (!label && !facts) return null;
    return { label: label || null, facts: facts || null };
  }

  /* -------------------------------- http fetch ------------------------------- */
  async function fetchOFF(barcode, { lang="en", timeoutMs=6500, signal } = {}) {
    // OFF v2: https://world.openfoodfacts.org/api/v2/product/{code}.json
    const base = "https://world.openfoodfacts.org/api/v2/product";
    const url = `${base}/${barcode}.json?fields=code,brands,product_name,quantity,ingredients,ingredients_text,categories,categories_tags,additives_tags,allergens_tags,traces_tags,images,image_url,image_front_url,image_small_url,selected_images,nutriments,nutriscore_grade`;
    const ctrl = !signal ? new AbortController() : null;
    const t = !signal ? setTimeout(() => ctrl.abort(), timeoutMs) : null;

    try {
      const res = await fetch(url, { signal: signal || (ctrl && ctrl.signal) });
      if (!res.ok) return { ok:false, status: res.status, error: "http-"+res.status };
      const json = await res.json();
      if (!json || json.status !== 1 || !json.product) return { ok:false, error: "not-found" };
      return { ok:true, raw: json };
    } catch (e) {
      return { ok:false, error: String(e && e.name === "AbortError" ? "timeout" : e) };
    } finally {
      if (t) clearTimeout(t);
    }
  }

  async function tryLookups(barcode) {
    // Try barcode, then if EAN13 with leading 0 → try dropping leading 0 (UPC12)
    const attempts = [];
    attempts.push(barcode);
    if (barcode.length === 13 && barcode.startsWith("0")) attempts.push(barcode.slice(1));
    // OFF sometimes accepts zero-padded forms; include both if distinct
    const tried = new Set();
    for (const code of attempts) {
      if (!code || tried.has(code)) continue;
      tried.add(code);
      const r = await fetchOFF(code);
      if (r.ok) return r;
      // small backoff then continue
      await sleep(120);
    }
    return { ok:false, error:"not-found" };
  }

  /* ------------------------------ mapping → shape ---------------------------- */
  function toNormalized(rawProduct, meta = {}) {
    if (!normalize || !normalize.normalizeFromProvider) {
      // super minimal fallback if normalizer isn't available
      const p = rawProduct || {};
      return {
        ok: true,
        product: {
          upc: toStr(p.code || ""),
          brand: toStr(p.brands || "").split(",")[0] || null,
          name: toStr(p.product_name || null) || null,
          sizeQty: null,
          sizeUnit: "ea",
          ingredients: parseIngredients(p),
          categories: parseCategories(p),
          images: bestImage(p),
          nutrition: parseNutrition(p),
          warnings: parseWarnings(p),
          offers: [],
          price: null,
          source: { key: "openfoodfacts", label: "OpenFoodFacts", trust: 0.65 },
          sessionId: meta.sessionId || null,
          sessionLabel: meta.sessionLabel || null,
          observedISO: nowISO(),
        },
        raw: rawProduct,
      };
    }

    // OFF → your normalized shape via central normalizer
    const qty = toStr(rawProduct.quantity || ""); // examples like "500 g", "12 oz"
    const norm = normalize.normalizeFromProvider(
      "openfoodfacts",
      {
        upc: toStr(rawProduct.code || ""),
        brand: toStr(rawProduct.brands || "").split(",")[0] || null,
        name: toStr(rawProduct.product_name || null) || null,
        // feed size hints to normalizer
        size: qty,
        ingredients: parseIngredients(rawProduct),
        categories: parseCategories(rawProduct),
        images: bestImage(rawProduct),
        nutrition: parseNutrition(rawProduct),
        warnings: parseWarnings(rawProduct),
        // OFF rarely has live price/offers; leave empty (other providers/PriceBook fill this)
        offers: [],
      },
      {
        trust: 0.65,
        label: "OpenFoodFacts",
        url: "https://world.openfoodfacts.org",
        sessionId: meta.sessionId || null,
        sessionLabel: meta.sessionLabel || null,
      }
    );

    return { ok: true, product: norm, raw: rawProduct };
  }

  /* ------------------------------- public API -------------------------------- */
  /**
   * lookup(query, ctx?)
   * query: { upc?|barcode?, sessionId?, sessionLabel? }
   * ctx:   { timeoutMs?, signal? }
   * returns: { ok, product, raw } on success or { ok:false, error }
   */
  async function lookup(query = {}, ctx = {}) {
    const bc = canonicalBarcode(query.upc || query.barcode);
    if (!bc) return { ok:false, error:"invalid-barcode" };

    eventBus.emit?.("product:provider:query", { provider:"openfoodfacts", barcode: bc });

    // Try OFF, allow quick retry with alt form
    const res = await tryLookups(bc);
    if (!res.ok) {
      eventBus.emit?.("product:provider:fail", { provider:"openfoodfacts", barcode: bc, error: res.error });
      return { ok:false, error: res.error || "not-found" };
    }

    const raw = res.raw?.product || null;
    if (!raw) return { ok:false, error:"not-found" };

    const mapped = toNormalized(raw, { sessionId: query.sessionId, sessionLabel: query.sessionLabel });
    if (mapped?.ok) {
      eventBus.emit?.("product:provider:ok", { provider:"openfoodfacts", barcode: bc, brand: mapped.product.brand, name: mapped.product.name });
      return mapped;
    }
    return { ok:false, error:"normalize-failed" };
  }

  /**
   * registerWithResolver(resolver, meta?)
   * Convenience for wiring into your ProductResolver registry.
   * meta: { trust?, timeoutMs?, rateLimitMs?, label? }
   */
  function registerWithResolver(resolver, meta) {
    const api = resolver || (ProductResolver && ProductResolver.createProductResolver && ProductResolver.createProductResolver());
    if (!api || !api.registerProviderAdapter) return false;
    return api.registerProviderAdapter("openfoodfacts", lookup, Object.assign({
      trust: 0.65,
      timeoutMs: 7000,
      rateLimitMs: 250,
      label: "OpenFoodFacts",
    }, meta || {}));
  }

  /* --------------------------------- exports --------------------------------- */
  var out = {
    lookup,               // main function used by ProductResolver
    registerWithResolver, // helper to register into registry
    __util: { canonicalBarcode, parseIngredients, parseWarnings, parseCategories, parseNutrition, bestImage },
  };

  try { module.exports = out; } catch (_e) {}
  try { (globalThis || window).OpenFoodFactsProvider = out; } catch (_e) {}
})();
