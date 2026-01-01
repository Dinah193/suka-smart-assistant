/* eslint-disable no-console */
// src/features/scan-compare-trust/services/products/providers/GS1Resolver.js
// GS1 prefix / brand-owner metadata inference from UPC/EAN/GTIN.
// Dependency-light, ESM/CJS friendly. Dexie optional.

(function () {
  /* -------------------------------- safe imports -------------------------------- */
  var normalize = null;
  try {
    normalize = require("../normalize.js"); // { normalizeFromProvider, __helpers }
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

  var DexieDB = null;
  try {
    DexieDB = require("@/db")?.default || require("@/db");
  } catch (_e) {}

  /* ---------------------------------- utils ----------------------------------- */
  var toStr = (v)=> (v==null?"":String(v)).trim();
  var lc   = (v)=> toStr(v).toLowerCase();
  var nowISO = ()=> new Date().toISOString();

  function digitsOnly(s) { return String(s||"").replace(/[^0-9]/g,""); }

  function canonicalBarcode(input) {
    const s = digitsOnly(input);
    if (!s) return null;
    // Accept 8 (EAN-8), 12 (UPC-A), 13 (EAN-13), 14 (GTIN-14)
    if ([8,12,13,14].includes(s.length)) return s;
    // If 11, pad to UPC-12
    if (s.length === 11) return "0"+s;
    return null;
  }

  // Mod-10 (UPC/EAN) check digit computation
  function computeCheckDigit(codeWithoutCheck) {
    const s = digitsOnly(codeWithoutCheck);
    const len = s.length;
    let sum = 0;
    // For UPC/EAN: from right, weight 3,1 alternation; but easier: for 12-digit UPC,
    // odd positions (1-based) *3 plus even positions.
    // We'll handle length generically by aligning so that the check digit is at the rightmost +1.
    for (let i = 0; i < len; i++) {
      const digit = Number(s[len - 1 - i]);
      const weight = (i % 2 === 0) ? 3 : 1; // rightmost becomes *3
      sum += digit * weight;
    }
    const mod = sum % 10;
    return mod === 0 ? 0 : (10 - mod);
  }

  function validateCheckDigit(fullCode) {
    const s = digitsOnly(fullCode);
    if (s.length < 8) return { valid:false, reason:"too-short" };
    const body = s.slice(0, -1);
    const expected = computeCheckDigit(body);
    const actual = Number(s.slice(-1));
    return { valid: expected === actual, expected, actual };
  }

  /* ------------------------------- fallback tables --------------------------- */
  // Minimal issuer-country map. You can override/extend via Dexie kv: space "gs1:prefixes"
  // with { key:"<range or prefix>", value:{ country, note? } }
  const DEFAULT_ISSUER = [
    // ranges expressed as [start, end, country]
    [ "000", "019", "US/CA" ],
    [ "030", "039", "US" ],
    [ "040", "049", "US" ], // used for pharmaceuticals (varies), coupons
    [ "050", "059", "Coupons/US" ],
    [ "060", "139", "US/CA" ],
    [ "300", "379", "FR" ],
    [ "380", "380", "BG" ],
    [ "383", "383", "SI" ],
    [ "385", "385", "HR" ],
    [ "400", "440", "DE" ],
    [ "450", "459", "JP" ],
    [ "460", "469", "RU" ],
    [ "470", "470", "KG" ],
    [ "471", "471", "TW" ],
    [ "474", "474", "EE" ],
    [ "475", "475", "LV" ],
    [ "476", "476", "AZ" ],
    [ "477", "477", "LT" ],
    [ "478", "478", "UZ" ],
    [ "479", "479", "LK" ],
    [ "480", "480", "PH" ],
    [ "481", "481", "BY" ],
    [ "482", "482", "UA" ],
    [ "484", "484", "MD" ],
    [ "485", "485", "AM" ],
    [ "486", "486", "GE" ],
    [ "489", "489", "HK" ],
    [ "490", "499", "JP" ],
    [ "500", "509", "GB" ],
    [ "520", "521", "GR" ],
    [ "529", "529", "CY" ],
    [ "530", "530", "AL" ],
    [ "531", "531", "MK" ],
    [ "535", "535", "MT" ],
    [ "539", "539", "IE" ],
    [ "540", "549", "BE/LU" ],
    [ "560", "560", "PT" ],
    [ "569", "569", "IS" ],
    [ "570", "579", "DK" ],
    [ "590", "590", "PL" ],
    [ "594", "594", "RO" ],
    [ "599", "599", "HU" ],
    [ "600", "601", "ZA" ],
    [ "603", "603", "GH" ],
    [ "608", "608", "BH" ],
    [ "609", "609", "MU" ],
    [ "611", "611", "MA" ],
    [ "613", "613", "DZ" ],
    [ "615", "615", "NG" ],
    [ "616", "616", "KE" ],
    [ "619", "619", "TN" ],
    [ "621", "621", "SY" ],
    [ "622", "622", "EG" ],
    [ "624", "624", "LY" ],
    [ "625", "625", "JO" ],
    [ "626", "626", "IR" ],
    [ "627", "627", "KW" ],
    [ "628", "628", "SA" ],
    [ "629", "629", "AE" ],
    [ "640", "649", "FI" ],
    [ "690", "699", "CN" ],
    [ "700", "709", "NO" ],
    [ "729", "729", "IL" ],
    [ "730", "739", "SE" ],
    [ "740", "745", "Central America" ],
    [ "746", "746", "DO" ],
    [ "750", "750", "MX" ],
    [ "754", "755", "CA" ],
    [ "759", "759", "VE" ],
    [ "760", "769", "CH" ],
    [ "770", "771", "CO" ],
    [ "773", "773", "UY" ],
    [ "775", "775", "PE" ],
    [ "777", "777", "BO" ],
    [ "779", "779", "AR" ],
    [ "780", "780", "CL" ],
    [ "784", "784", "PY" ],
    [ "785", "785", "PE" ],
    [ "786", "786", "EC" ],
    [ "789", "790", "BR" ],
    [ "800", "839", "IT" ],
    [ "840", "849", "ES" ],
    [ "850", "850", "CU" ],
    [ "858", "858", "SK" ],
    [ "859", "859", "CZ" ],
    [ "860", "860", "RS" ],
    [ "865", "865", "MN" ],
    [ "867", "867", "KP" ],
    [ "869", "869", "TR" ],
    [ "870", "879", "NL" ],
    [ "880", "880", "KR" ],
    [ "885", "885", "TH" ],
    [ "888", "888", "SG" ],
    [ "890", "890", "IN" ],
    [ "893", "893", "VN" ],
    [ "896", "896", "PK" ],
    [ "899", "899", "ID" ],
    [ "900", "919", "AT" ],
    [ "930", "939", "AU" ],
    [ "940", "949", "NZ" ],
    [ "950", "950", "GS1 Global Office" ],
    [ "955", "955", "MY" ],
    [ "958", "958", "MO" ],
  ];

  function prefixToCountry(prefix3) {
    const p = String(prefix3).padStart(3, "0").slice(0,3);
    for (const row of DEFAULT_ISSUER) {
      const [a, b, c] = row;
      if (p >= a && p <= b) return c;
    }
    return null;
  }

  // Simple GCP (company prefix) guess: for UPC-A, GS1 in US/CA often uses variable-length GCP.
  // We provide a heuristic: try 7, 6, 5 digits after the first number for UPC-12.
  // (Accurate GCP requires licensed tables; here we approximate.)
  function guessGcp(upcOrEan) {
    const s = canonicalBarcode(upcOrEan);
    if (!s) return null;
    // 12-digit UPC: try 6–7 digit prefixes (after number system)
    if (s.length === 12) {
      const ns = s.slice(0,1);
      const body = s.slice(1, 11); // without check digit
      const options = [7, 6, 5].map(len => ns + body.slice(0, len));
      return options[0]; // pick longest guess
    }
    // 13-digit EAN: GCP can be 7–9; we pick first 7
    if (s.length === 13) return s.slice(0,7);
    // 14-digit GTIN: drop the packaging level (first), treat remaining 13 as EAN
    if (s.length === 14) return s.slice(1, 8);
    // 8-digit EAN-8: company prefix smaller; pick first 4
    if (s.length === 8) return s.slice(0,4);
    return null;
  }

  /* --------------------------------- cache layer ----------------------------- */
  const LS_CACHE = "gs1:meta:cache:v1";
  function lsReadAll(){ try{ const v = localStorage.getItem(LS_CACHE); return v? JSON.parse(v):{}; }catch{ return {}; } }
  function lsWriteAll(obj){ try{ localStorage.setItem(LS_CACHE, JSON.stringify(obj)); }catch{} }

  async function cacheGet(key) {
    if (DexieDB?.kv) {
      try {
        const row = await DexieDB.kv.get({ space:"gs1:meta", key });
        return row?.value || null;
      } catch { return null; }
    }
    return lsReadAll()[key] || null;
  }

  async function cachePut(key, value) {
    if (DexieDB?.kv) {
      try { await DexieDB.kv.put({ space:"gs1:meta", key, value, updatedAt: Date.now() }); } catch {}
      return;
    }
    const all = lsReadAll(); all[key] = value; lsWriteAll(all);
  }

  /* ----------------------------- mapping → shape ----------------------------- */
  function buildGs1Categories(meta) {
    const out = [];
    if (meta.issuerCountry) out.push(`gs1-country:${lc(meta.issuerCountry)}`);
    if (meta.symbology) out.push(`barcode:${lc(meta.symbology)}`);
    if (meta.packagingLevel != null) out.push(`gtin-pack:${meta.packagingLevel}`);
    return out;
  }

  function symbologyOf(code) {
    const len = (code||"").length;
    if (len === 8) return "EAN-8";
    if (len === 12) return "UPC-A";
    if (len === 13) return "EAN-13";
    if (len === 14) return "GTIN-14";
    return "UNKNOWN";
  }

  function packagingLevelOf(gtin14) {
    // First digit in GTIN-14 is the packaging level indicator (0=base/each)
    if (!gtin14 || gtin14.length !== 14) return null;
    return Number(gtin14[0]); // 0..8 (9 variable)
  }

  function toNormalizedGs1(code, meta = {}) {
    const sessionId = meta.sessionId || null;
    const sessionLabel = meta.sessionLabel || null;

    const upcCandidate =
      (code.length === 12 && code) ||
      (code.length === 13 && code.startsWith("0") ? code.slice(1) : null) ||
      null;

    // If the normalizer is present, build via normalizeFromProvider for consistent shape
    if (normalize?.normalizeFromProvider) {
      const categories = buildGs1Categories(meta);
      const norm = normalize.normalizeFromProvider(
        "gs1meta",
        {
          upc: upcCandidate || null,
          // leave brand/name null; we only provide metadata (categories + warnings)
          categories,
          warnings: meta.check?.valid === false
            ? [`bad-check-digit: expected ${meta.check.expected}, got ${meta.check.actual}`]
            : [],
          images: [],
          offers: [],
        },
        {
          trust: 0.55,
          label: "GS1 Metadata",
          url: "https://www.gs1.org/",
          sessionId, sessionLabel,
        }
      );
      // attach more info into source url? kept small
      return norm;
    }

    // Fallback minimal object if normalizer unavailable
    return {
      upc: upcCandidate || null,
      brand: null,
      name: null,
      sizeQty: null,
      sizeUnit: "ea",
      ingredients: [],
      categories: buildGs1Categories(meta),
      images: [],
      warnings: meta.check?.valid === false
        ? [`bad-check-digit: expected ${meta.check.expected}, got ${meta.check.actual}`]
        : [],
      offers: [],
      price: null,
      source: { key: "gs1meta", label: "GS1 Metadata", trust: 0.55 },
      sessionId, sessionLabel,
      observedISO: nowISO(),
    };
  }

  /* ---------------------------------- lookup --------------------------------- */
  /**
   * lookup(query, ctx?)
   * query: { upc?|barcode?|gtin?, sessionId?, sessionLabel? }
   * returns: { ok, product, raw }
   * raw: { code, check, issuerCountry, gcpGuess, symbology, packagingLevel }
   */
  async function lookup(query = {}, ctx = {}) {
    const code = canonicalBarcode(query.upc || query.barcode || query.gtin);
    if (!code) return { ok:false, error:"invalid-barcode" };

    const cacheKey = `gs1:${code}`;
    const cached = await cacheGet(cacheKey);
    if (cached) {
      eventBus.emit?.("product:provider:cache_hit", { provider:"gs1meta", code });
      return { ok:true, product: cached.product, raw: cached.raw, cached: true };
    }

    eventBus.emit?.("product:provider:query", { provider:"gs1meta", code });

    const check = validateCheckDigit(code);
    const prefix3 = code.slice(0,3);
    const issuerCountry = prefixToCountry(prefix3);
    const symbology = symbologyOf(code);
    const packagingLevel = packagingLevelOf(code);
    const gcpGuess = guessGcp(code);

    const raw = { code, check, issuerCountry, gcpGuess, symbology, packagingLevel };
    const product = toNormalizedGs1(code, { check, issuerCountry, symbology, packagingLevel, sessionId: query.sessionId, sessionLabel: query.sessionLabel });

    const payload = { product, raw };
    await cachePut(cacheKey, payload);

    eventBus.emit?.("product:provider:ok", { provider:"gs1meta", code, issuerCountry, symbology });
    return { ok:true, product, raw };
  }

  /* ----------------------- annotate existing normalized ---------------------- */
  /**
   * annotateProduct(product)
   * Mutates a normalized product (from any provider) by appending GS1 categories/warnings.
   * Returns the same object for chaining.
   */
  function annotateProduct(product) {
    if (!product) return product;
    const upc = product.upc || null;
    const gtin14 = product.gtin && product.gtin.length === 14 ? product.gtin : null;
    const rawCode = gtin14 || (product.ean && product.ean.length === 13 ? product.ean : null) || upc;
    const code = canonicalBarcode(rawCode);
    if (!code) return product;

    const check = validateCheckDigit(code);
    const issuerCountry = prefixToCountry(code.slice(0,3));
    const symbology = symbologyOf(code);
    const packagingLevel = packagingLevelOf(code);

    const cats = product.categories || [];
    const gs1Cats = buildGs1Categories({ issuerCountry, symbology, packagingLevel });
    product.categories = Array.from(new Set([...cats, ...gs1Cats]));

    if (check.valid === false) {
      product.warnings = Array.from(new Set([...(product.warnings||[]), `bad-check-digit: expected ${check.expected}, got ${check.actual}`]));
    }
    return product;
  }

  /* ---------------------------- registry helper ----------------------------- */
  /**
   * registerWithResolver(resolver, meta?)
   * Registers this provider into ProductResolver so it can contribute metadata to merges.
   */
  function registerWithResolver(resolver, meta) {
    const api = resolver || (ProductResolver && ProductResolver.createProductResolver && ProductResolver.createProductResolver());
    if (!api || !api.registerProviderAdapter) return false;
    return api.registerProviderAdapter("gs1meta", lookup, Object.assign({
      trust: 0.55,
      timeoutMs: 150,      // very fast (local computation)
      rateLimitMs: 0,
      label: "GS1 Metadata",
    }, meta || {}));
  }

  /* ---------------------------------- exports -------------------------------- */
  var out = {
    lookup,
    registerWithResolver,
    annotateProduct,
    __util: {
      canonicalBarcode,
      computeCheckDigit,
      validateCheckDigit,
      prefixToCountry,
      guessGcp,
      symbologyOf,
      packagingLevelOf,
    }
  };

  try { module.exports = out; } catch (_e) {}
  try { (globalThis || window).GS1Resolver = out; } catch (_e) {}
})();
