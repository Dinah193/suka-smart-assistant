/* eslint-disable no-console */
// src/features/scan-compare-trust/services/products/ProductResolver.js
// Multi-provider product aggregator (resolve → safety → pricing → coupons).
// - Normalizes payload shape across providers
// - Confidence-scored merge (majority + provider trust + field quality)
// - TTL cache (Dexie optional, LS fallback)
// - Per-provider rate limit + timeouts
// - Emits SourceAttribution for UI
// - Records observed prices into usePriceBook (optional)
// - Plays nice with: useStoresDirectory (adapters), useSafetyPrefs.evaluateProduct (optional),
//   useCouponPrefs (via events), useCycleInsights (via NBA hints)

(function () {
  /* ------------------------------ safe imports ------------------------------ */
  var eventBus = { emit() {}, on() {}, off() {} };
  try {
    var eb = require("@/services/events/eventBus");
    eventBus = eb?.default || eb?.eventBus || eb || eventBus;
  } catch (_e) {}

  var DexieDB = null;
  try {
    DexieDB = require("@/db")?.default || require("@/db");
  } catch (_e) {}

  var useStoresDirectory = null;
  try {
    useStoresDirectory =
      require("@/features/scan-compare-trust/stores/useStoresDirectory")
        .default || null;
  } catch (_e) {}

  var safetyEval = null; // named export from useSafetyPrefs
  try {
    safetyEval =
      require("@/features/scan-compare-trust/stores/useSafetyPrefs")
        .evaluateProduct || null;
  } catch (_e) {}

  var priceBookRecord = null;
  try {
    priceBookRecord =
      require("@/features/scan-compare-trust/stores/usePriceBook")
        .priceBookRecord || null;
  } catch (_e) {}

  var nanoid = (len = 6) =>
    Math.random()
      .toString(36)
      .slice(2, 2 + len);
  try {
    nanoid = require("nanoid").nanoid || nanoid;
  } catch (_e) {}

  /* --------------------------------- utils --------------------------------- */
  var nowISO = () => new Date().toISOString();
  var ms = (n) => n;
  var clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  var toStr = (v) => (v == null ? "" : String(v)).trim();
  var num = (v) => (v == null ? null : Number(v));

  function timeout(promise, ms, label = "timeout") {
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve({ ok: false, error: label }), ms);
      promise
        .then((v) => {
          clearTimeout(t);
          resolve(v);
        })
        .catch((e) => {
          clearTimeout(t);
          resolve({ ok: false, error: String(e) });
        });
    });
  }

  function uniq(arr) {
    return Array.from(new Set(arr.filter(Boolean)));
  }

  /* ------------------------------- cache layer ------------------------------ */
  // Dexie (optional): productsCache: { key, value, updatedAt, ttlMs }
  // LS fallback: "productResolver:cache:v1" => { [key]: { value, updatedAt, ttlMs } }
  var LS_CACHE_KEY = "productResolver:cache:v1";
  function lsReadAll() {
    try {
      const v = localStorage.getItem(LS_CACHE_KEY);
      return v ? JSON.parse(v) : {};
    } catch {
      return {};
    }
  }
  function lsWriteAll(obj) {
    try {
      localStorage.setItem(LS_CACHE_KEY, JSON.stringify(obj));
    } catch {}
  }

  async function cacheGet(key) {
    if (DexieDB?.productsCache) {
      try {
        const row = await DexieDB.productsCache.get(key);
        if (!row) return null;
        if (row.ttlMs && Date.now() - row.updatedAt > row.ttlMs) return null;
        return row.value;
      } catch {
        return null;
      }
    }
    const all = lsReadAll();
    const row = all[key];
    if (!row) return null;
    if (row.ttlMs && Date.now() - row.updatedAt > row.ttlMs) return null;
    return row.value;
  }

  async function cachePut(key, value, ttlMs) {
    if (DexieDB?.productsCache) {
      try {
        await DexieDB.productsCache.put({
          key,
          value,
          ttlMs: ttlMs || 0,
          updatedAt: Date.now(),
        });
      } catch {}
      return;
    }
    const all = lsReadAll();
    all[key] = { value, ttlMs: ttlMs || 0, updatedAt: Date.now() };
    lsWriteAll(all);
  }

  /* --------------------------- provider registry ---------------------------- */
  // Providers register a function that takes (query, ctx) and returns:
  // {
  //   ok: true|false,
  //   product: {
  //     upc, ean, gtin, brand, name, sizeQty, sizeUnit, variant?,
  //     ingredients[], categories[], images[], nutrition?:{label?, facts?}, warnings[],
  //     price?:{ amount, currency, sizeQty?, sizeUnit?, promo?, store? },
  //     offers?:[{ store, adapterKey?, price, currency, sizeQty?, sizeUnit?, promo? }],
  //     source:{ key:"walmart", label:"Walmart API", url?, trust: 0..1 }
  //   },
  //   raw?: any
  // }
  var registry = new Map(); // key -> { fn, trust, timeoutMs, rateLimit }
  var lastCallAt = new Map(); // key -> ts

  function registerProviderAdapter(key, fn, meta) {
    if (!key || typeof fn !== "function") return false;
    registry.set(key, {
      fn,
      trust:
        meta && typeof meta.trust === "number" ? clamp(meta.trust, 0, 1) : 0.6,
      timeoutMs: (meta && meta.timeoutMs) || 6000,
      rateLimitMs: (meta && meta.rateLimitMs) || 300, // minimal throttling
      label: (meta && meta.label) || key,
    });
    eventBus.emit?.("product:provider:registered", {
      key,
      label: meta?.label || key,
    });
    return true;
  }

  function listProviders() {
    return Array.from(registry.keys());
  }

  async function callProvider(key, query, ctx) {
    const meta = registry.get(key);
    if (!meta) return { ok: false, error: "not-registered" };

    // basic rate-limit
    const last = lastCallAt.get(key) || 0;
    const delta = Date.now() - last;
    if (delta < meta.rateLimitMs)
      await new Promise((r) => setTimeout(r, meta.rateLimitMs - delta));
    lastCallAt.set(key, Date.now());

    const p = Promise.resolve().then(() => meta.fn(query, ctx));
    const res = await timeout(p, meta.timeoutMs, "provider-timeout");
    if (res && res.ok && res.product) {
      res.product.source = res.product.source || {
        key,
        label: meta.label,
        trust: meta.trust,
      };
    }
    return res;
  }

  /* ------------------------------- normalization --------------------------- */
  function canonicalUPC(input) {
    const s = String(input || "").replace(/[^0-9]/g, "");
    if (!s) return null;
    // Normalize EAN-13 to UPC-12 when possible (drop leading 0)
    if (s.length === 13 && s.startsWith("0")) return s.slice(1);
    if (s.length === 12) return s;
    if (s.length === 11) return "0" + s;
    // Accept 8, 13, 14 as-is (GTIN-14); store in gtin but keep upc null
    return s.length === 12 ? s : null;
  }

  function normUnit(u) {
    const m = String(u || "").toLowerCase();
    if (["g", "gram", "grams"].includes(m)) return "g";
    if (["kg", "kilogram", "kilograms"].includes(m)) return "kg";
    if (["oz", "ounce", "ounces"].includes(m)) return "oz";
    if (["lb", "lbs", "pound", "pounds"].includes(m)) return "lb";
    if (["ml", "milliliter", "milliliters"].includes(m)) return "ml";
    if (["l", "liter", "litre", "liters", "litres"].includes(m)) return "l";
    if (["floz", "fl oz", "fluid ounce", "fluid ounces"].includes(m))
      return "floz";
    if (["ea", "each", "count", "ct", "piece", "pcs"].includes(m)) return "ea";
    return "ea";
  }

  function cleanArr(arr) {
    return uniq((arr || []).map((x) => toStr(x)).filter(Boolean));
  }

  function emptyProduct() {
    return {
      upc: null,
      ean: null,
      gtin: null,
      brand: null,
      name: null,
      variant: null,
      sizeQty: null,
      sizeUnit: "ea",
      ingredients: [],
      categories: [],
      images: [],
      nutrition: null,
      warnings: [],
      offers: [],
      price: null,
    };
  }

  /* ------------------------------ merge strategy ---------------------------- */
  // Confidence per field:
  //  - base provider trust
  //  - field quality (length, numeric sanity)
  //  - consensus bonus (same value across >1 providers)
  function scoreField(val, meta, field) {
    if (val == null || (typeof val === "string" && !val.trim())) return 0;
    var s = meta.trust || 0.5;
    if (typeof val === "string") s += clamp(val.length / 60, 0, 0.3);
    if (field === "sizeQty" && Number.isFinite(Number(val))) s += 0.2;
    return clamp(s, 0, 1);
  }

  function mergeProducts(products) {
    const merged = emptyProduct();
    const attrib = []; // [{key,label,trust, fields:{ brand:true, name:true,... }, raw?}]
    const votes = {};

    for (const p of products) {
      if (!p?.product) continue;
      const src = p.product.source || {
        key: "unknown",
        label: "Unknown",
        trust: 0.5,
      };
      const meta = {
        key: src.key,
        label: src.label,
        trust: num(src.trust) ?? 0.6,
      };
      const fieldsUsed = {};

      // UPC / GTIN
      const upc = canonicalUPC(
        p.product.upc || p.product.gtin || p.product.ean
      );
      if (upc && !merged.upc) {
        merged.upc = upc;
        fieldsUsed.upc = true;
      }
      if (!merged.gtin && p.product.gtin) {
        merged.gtin = toStr(p.product.gtin);
        fieldsUsed.gtin = true;
      }
      if (!merged.ean && p.product.ean) {
        merged.ean = toStr(p.product.ean);
        fieldsUsed.ean = true;
      }

      // brand/name/variant
      [
        ["brand", "brand"],
        ["name", "name"],
        ["variant", "variant"],
      ].forEach(([f, k]) => {
        const v = toStr(p.product[f] || "");
        if (!v) return;
        votes[k] = votes[k] || {};
        votes[k][v] = (votes[k][v] || 0) + scoreField(v, meta, k);
      });

      // size
      const qty = num(p.product.sizeQty);
      const unit = normUnit(p.product.sizeUnit);
      if (qty && !merged.sizeQty) {
        merged.sizeQty = qty;
        fieldsUsed.sizeQty = true;
      }
      if (unit && !merged.sizeUnit) {
        merged.sizeUnit = unit;
        fieldsUsed.sizeUnit = true;
      }

      // arrays
      merged.ingredients = uniq([
        ...(merged.ingredients || []),
        ...cleanArr(p.product.ingredients),
      ]);
      merged.categories = uniq([
        ...(merged.categories || []),
        ...cleanArr(p.product.categories),
      ]);
      merged.images = uniq([
        ...(merged.images || []),
        ...cleanArr(p.product.images),
      ]);
      merged.warnings = uniq([
        ...(merged.warnings || []),
        ...cleanArr(p.product.warnings),
      ]);

      // offers/price
      const offers = Array.isArray(p.product.offers)
        ? p.product.offers
        : p.product.price
        ? [
            {
              store: p.product.price.store || null,
              price: num(p.product.price.amount),
              currency: p.product.price.currency || "USD",
              sizeQty: num(p.product.price.sizeQty) || qty || null,
              sizeUnit: normUnit(p.product.price.sizeUnit || unit),
              promo: !!p.product.price.promo,
            },
          ]
        : [];
      for (const o of offers) {
        const norm = {
          store: toStr(o.store) || null,
          adapterKey: toStr(o.adapterKey) || null,
          price: num(o.price),
          currency: o.currency || "USD",
          sizeQty: num(o.sizeQty) || null,
          sizeUnit: normUnit(o.sizeUnit) || "ea",
          promo: !!o.promo,
          observedISO: p.product.observedISO || nowISO(),
          sourceKey: meta.key,
        };
        if (Number.isFinite(norm.price)) merged.offers.push(norm);
      }

      attrib.push({
        key: meta.key,
        label: meta.label,
        trust: meta.trust,
        fields: fieldsUsed,
        raw: p.raw || null,
      });
    }

    // finalize brand/name/variant by votes
    ["brand", "name", "variant"].forEach((k) => {
      if (!votes[k]) return;
      const pick = Object.entries(votes[k]).sort((a, b) => b[1] - a[1])[0];
      if (pick) merged[k] = pick[0];
    });

    // set a primary price = best (lowest) offer by default
    if (merged.offers.length) {
      const best = merged.offers
        .filter((o) => Number.isFinite(o.price))
        .sort((a, b) => a.price - b.price)[0];
      merged.price = best
        ? {
            amount: best.price,
            currency: best.currency,
            store: best.store,
            sizeQty: best.sizeQty,
            sizeUnit: best.sizeUnit,
            promo: best.promo,
          }
        : null;
    }

    return { merged, attribution: attrib };
  }

  /* ------------------------------- main resolve ----------------------------- */
  // public API:
  //   createProductResolver(deps?) -> { resolve, registerProviderAdapter, listProviders, evictCache }
  //   resolve(input, ctx?) where input = { upc?|barcode?|image?|ocrText? , store?, adapterKey?, sessionId?, sessionLabel? }
  function keyFor(input) {
    const upc = canonicalUPC(input.upc || input.barcode);
    const k = JSON.stringify({
      upc,
      store: toStr(input.store),
      adapterKey: toStr(input.adapterKey),
      ocr: toStr(input.ocrText).slice(0, 64), // shallow influence
    });
    return `prod:${k}`;
  }

  async function resolveInternal(input, ctx, providers) {
    const key = keyFor(input);
    const cached = await cacheGet(key);
    if (cached) {
      eventBus.emit?.("product:resolve:cache_hit", { key, input });
      return { ok: true, ...cached, cached: true };
    }

    eventBus.emit?.("product:resolve:start", { input, ctx });

    // Choose providers: either by adapterKey, store, or all registered.
    const chosen =
      providers && providers.length ? providers : Array.from(registry.keys());
    const calls = chosen.map((k) => callProvider(k, input, ctx));
    const results = await Promise.all(calls);

    const ok = results.filter((r) => r && r.ok && r.product);
    if (!ok.length) {
      const fail = results.map((r, i) => ({
        provider: chosen[i],
        err: r?.error || "no-result",
      }));
      eventBus.emit?.("product:resolve:none", { input, failures: fail });
      return {
        ok: false,
        error: "no-provider-returned-product",
        failures: fail,
      };
    }

    const { merged, attribution } = mergeProducts(ok);

    // Annotate with session
    merged.sessionId = input.sessionId || null;
    merged.sessionLabel = input.sessionLabel || null;
    merged.observedISO = nowISO();

    // Persist cache
    const payload = { product: merged, attribution };
    await cachePut(key, payload, ctx?.ttlMs || 6 * 60 * 60 * 1000); // 6h default

    // Emit attribution for UI
    eventBus.emit?.("source:attribution", {
      domain: "products",
      key,
      items: attribution.map((a) => ({
        providerKey: a.key,
        label: a.label,
        trust: a.trust,
        fields: a.fields,
      })),
    });

    // Record price(s) -> PriceBook (optional)
    try {
      if (priceBookRecord && merged.offers?.length) {
        for (const o of merged.offers) {
          if (!Number.isFinite(o.price)) continue;
          await priceBookRecord({
            upc: merged.upc,
            store: o.store,
            price: o.price,
            currency: o.currency || "USD",
            sizeQty: o.sizeQty || merged.sizeQty || 1,
            sizeUnit: o.sizeUnit || merged.sizeUnit || "ea",
            promo: !!o.promo,
            sessionId: merged.sessionId || null,
            observedISO: merged.observedISO,
            source: "product-resolver",
          });
        }
      }
    } catch (_e) {}

    // Emit downstream event for safety/pricing/coupons pipeline
    eventBus.emit?.("product:resolved", { key, product: merged, attribution });

    // Optional immediate safety evaluation (pure function; no hooks)
    try {
      if (safetyEval) {
        const safe = safetyEval(
          {
            upc: merged.upc,
            brand: merged.brand,
            store: input.store || merged.price?.store || null,
            ingredients: merged.ingredients,
            rawLabelText: null,
            categories: merged.categories,
          },
          null,
          {}
        );
        eventBus.emit?.("product:safety:precheck", {
          upc: merged.upc,
          ok: safe.ok,
          score: safe.score,
          violations: safe.violations,
        });
      }
    } catch (_e) {}

    // Invite coupons step to fetch options — the listener builds provider queries
    eventBus.emit?.("coupons:fetch:requested", {
      filters: {
        upc: merged.upc,
        brand: merged.brand,
        store: input.store || null,
        adapterKey: input.adapterKey || null,
      },
      requestedAtISO: nowISO(),
    });

    eventBus.emit?.("product:resolve:done", { key, upc: merged.upc });
    return { ok: true, product: merged, attribution, cached: false };
  }

  /* --------------------------------- factory -------------------------------- */
  function createProductResolver(deps) {
    const defaults = {
      ttlMs: 6 * 60 * 60 * 1000, // 6h
      providers: null, // array of keys to use; null -> all
    };
    const cfg = Object.assign({}, defaults, deps || {});

    return {
      /**
       * Resolve product from any of: upc, barcode, image (OCR handled by provider), ocrText.
       * ctx: { ttlMs?, providers?[], sessionId?, sessionLabel? }
       */
      resolve: async function (input, ctx) {
        const context = Object.assign({}, cfg, ctx || {});
        // If the caller passed a Store id or adapter, forward for provider hints
        const providers =
          Array.isArray(context.providers) && context.providers.length
            ? context.providers
            : cfg.providers;
        return await resolveInternal(input, context, providers);
      },

      /** Register a provider adapter at runtime. */
      registerProviderAdapter: function (key, fn, meta) {
        return registerProviderAdapter(key, fn, meta);
      },

      /** List registered providers. */
      listProviders: function () {
        return listProviders();
      },

      /** Evict a cache entry for a given input (e.g., force refresh). */
      evictCache: async function (input) {
        const key = keyFor(input);
        if (DexieDB?.productsCache) {
          try {
            await DexieDB.productsCache.delete(key);
          } catch {}
        } else {
          const all = lsReadAll();
          delete all[key];
          lsWriteAll(all);
        }
        eventBus.emit?.("product:cache:evicted", { key });
        return true;
      },
    };
  }

  /* --------------------------- example provider shim ------------------------ */
  // You can register concrete providers elsewhere. Here’s a minimal local echo
  // to illustrate the expected return shape if you want a quick smoke test.
  function __exampleLocalProvider(query) {
    const upc = canonicalUPC(query.upc || query.barcode) || "000000000000";
    return Promise.resolve({
      ok: true,
      product: {
        upc,
        brand: "Generic",
        name: "Sample Item",
        sizeQty: 1,
        sizeUnit: "ea",
        ingredients: [],
        categories: ["unknown"],
        images: [],
        offers: query.store
          ? [
              {
                store: query.store,
                price: 1.99,
                currency: "USD",
                sizeQty: 1,
                sizeUnit: "ea",
                promo: false,
              },
            ]
          : [],
        source: { key: "local", label: "Local Fallback", trust: 0.4 },
      },
      raw: null,
    });
  }

  /* --------------------------------- exports -------------------------------- */
  // CommonJS + ESM friendly
  var api = {
    createProductResolver,
    registerProviderAdapter,
    listProviders,
    __exampleLocalProvider, // optional export for tests
  };

  try {
    module.exports = api;
  } catch (_e) {}
  try {
    (globalThis || window).ProductResolver = api;
  } catch (_e) {}
})();
