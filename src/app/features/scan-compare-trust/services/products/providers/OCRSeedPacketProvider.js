/* eslint-disable no-console */
// src/features/scan-compare-trust/services/products/providers/OCRSeedPacketProvider.js
// OCR provider for seed packets with no UPC: image | dataURL | ocrText → normalized "product" (garden seed).
// Dependency-light: OCR function is injected via deps; Dexie optional; ESM/CJS friendly.

(function () {
  /* ------------------------------ safe imports ------------------------------ */
  var normalize = null;
  try {
    normalize = require("../normalize.js"); // { normalizeFromProvider, __helpers }
    normalize = normalize.default || normalize;
  } catch (_e) {}

  var ProductResolver = null;
  try {
    ProductResolver = require("../ProductResolver.js");
    ProductResolver = ProductResolver.default || ProductResolver;
  } catch (_e) {}

  var eventBus = { emit() {}, on() {}, off() {} };
  try {
    var eb = require("@/services/events/eventBus");
    eventBus = eb?.default || eb?.eventBus || eb || eventBus;
  } catch (_e) {}

  var DexieDB = null;
  try {
    DexieDB = require("@/db")?.default || require("@/db");
  } catch (_e) {}

  /* ---------------------------------- utils --------------------------------- */
  const nowISO = () => new Date().toISOString();
  const toStr = (v) => (v == null ? "" : String(v)).trim();
  const lc = (v) => toStr(v).toLowerCase();
  const uc = (v) => toStr(v).toUpperCase();
  const uniq = (a) => Array.from(new Set((a || []).filter(Boolean)));
  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));

  // tiny hash for cache keys (djb2)
  function tinyHash(s) {
    let h = 5381,
      i = s.length;
    while (i) h = (h * 33) ^ s.charCodeAt(--i);
    return (h >>> 0).toString(36);
  }

  function lines(text) {
    return toStr(text)
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  function cleanOCR(text) {
    let t = toStr(text);
    // common OCR confusions
    t = t.replace(/[‘’`]/g, "'").replace(/[“”]/g, '"');
    t = t.replace(/\bOZ\b/g, "oz").replace(/\bO\b(?=\d)/g, "0");
    t = t.replace(/[,;]+/g, ", ");
    return t;
  }

  /* ------------------------------ cache (optional) -------------------------- */
  const LS_KEY = "ocr:seed:cache:v1";
  function lsReadAll() {
    try {
      const v = localStorage.getItem(LS_KEY);
      return v ? JSON.parse(v) : {};
    } catch {
      return {};
    }
  }
  function lsWriteAll(obj) {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(obj));
    } catch {}
  }

  async function cacheGet(key) {
    if (DexieDB?.kv) {
      try {
        const row = await DexieDB.kv.get({ space: "ocr:seed", key });
        return row?.value || null;
      } catch {
        return null;
      }
    }
    return lsReadAll()[key] || null;
  }
  async function cachePut(key, value) {
    if (DexieDB?.kv) {
      try {
        await DexieDB.kv.put({
          space: "ocr:seed",
          key,
          value,
          updatedAt: Date.now(),
        });
      } catch {}
      return;
    }
    const all = lsReadAll();
    all[key] = value;
    lsWriteAll(all);
  }

  /* ------------------------------- field parsing ---------------------------- */
  // Regex fragments
  const RX = {
    species:
      /\b(tomato|pepper|cucumber|squash|zucchini|pumpkin|corn|bean|pea|lettuce|spinach|kale|chard|carrot|beet|radish|onion|leek|garlic|broccoli|cauliflower|cabbage|okra|eggplant|basil|cilantro|parsley|dill|sunflower|marigold|zinnia|cosmos|melon|watermelon|cantaloupe|mustard|arugula|turnip|rutabaga|celery|parsley|thyme|sage|rosemary|oregano)\b/i,
    days: /(?:days?\s*(?:to|till)?\s*(?:maturity|harvest)\s*[:\-]?\s*)(\d{1,3})/i,
    dttm: /\b(\d{1,3})\s*(?:days)\b/i,
    depth:
      /(?:plant(?:ing)?\s*depth|depth)\s*[:\-]?\s*([0-9\.\/]+\s*(?:in|inch|inches|cm|mm))/i,
    spacing:
      /(?:spacing|space\s*(?:plants)?|thin\s*to)\s*[:\-]?\s*([0-9\.\/]+\s*(?:in|inch|inches|cm|mm))/i,
    rowSpacing:
      /(?:row\s*spacing)\s*[:\-]?\s*([0-9\.\/]+\s*(?:in|inch|inches|cm|mm))/i,
    sun: /\b(full\s*sun|part\s*sun|partial\s*shade|shade|sun)\b/i,
    sow: /\b(sow\s*(?:indoors|outdoors|direct|direct\s*sow|transplant))\b/i,
    startIndoors:
      /(?:start\s*indoors|start\s*inside)\s*[:\-]?\s*(\d{1,2})\s*(?:weeks?)\s*(?:before|prior\s*to)\s*(?:last\s*frost)/i,
    afterFrost:
      /(?:transplant|plant)\s*(?:out|outdoors)?\s*(?:after|post)\s*(?:last\s*frost)/i,
    height:
      /(?:height)\s*[:\-]?\s*([0-9\.\/]+\s*(?:in|inch|inches|cm|mm|ft|feet))/i,
    zone: /\bzone\s*(\d{1,2})(?:[-–](\d{1,2}))?\b/i,
    packed: /(?:packed\s*for|pkd\s*for)\s*(\d{4})/i,
    lot: /\blot\s*[:\-]?\s*([A-Z0-9\-]+)\b/i,
    brand:
      /\b(eden brothers|burpee|johnny'?s\s*selected\s*seeds|johnnys|baker\s*creek|sow\s*right\s*seeds|botanical\s*interests|park\s*seed|high\s*mowing|territorial\s*seed|seed\s*savers\s*exchange|gurney'?s|hoss\s*tools|rare\s*seeds)\b/i,
    weight:
      /(?:net\s*wt\.?|weight)\s*[:\-]?\s*([0-9\.]+\s*(?:g|oz|grams?|ounces?))/i,
    varietyLabel: /(?:variety|cultivar)\s*[:\-]?\s*([A-Za-z0-9' \-]+)/i,
  };

  // Inch/cm string → number + unit
  function parseMeasure(s) {
    const t = lc(s);
    const m = t.match(/([0-9\.\/]+)\s*(in|inch|inches|cm|mm|ft|feet)/);
    if (!m) return { qty: null, unit: null };
    const raw = m[1];
    let qty = null;
    if (raw.includes("/")) {
      const [a, b] = raw.split("/").map(Number);
      qty = Number(a) / (Number(b) || 1);
    } else {
      qty = Number(raw);
    }
    const unit = m[2];
    return { qty, unit };
  }

  function pickVariety(text, speciesWord) {
    // Try explicit variety/cultivar line
    const v = text.match(RX.varietyLabel);
    if (v && v[1]) return toStr(v[1]).replace(/\s+/g, " ").trim();

    // Otherwise: title line heuristic = first bigcaps line not matching brand/species
    const ls = lines(text);
    const big = ls.filter((s) => /[A-Z]/.test(s) && s.length <= 60);
    const deny = new RegExp(
      `\\b(${(speciesWord || "").replace(/[-/\\^$*+?.()|[\]{}]/g, "")})\\b`,
      "i"
    );
    const varLine = big.find(
      (s) =>
        !deny.test(s) &&
        !/seed|heirloom|organic|non[-\s]?gmo|open[-\s]?pollinated/i.test(s) &&
        s.split(" ").length <= 5
    );
    return varLine || null;
  }

  function parseSeedMeta(text) {
    const t = cleanOCR(text);
    const brand = t.match(RX.brand)?.[1] || null;

    const speciesMatch = t.match(RX.species);
    const species = speciesMatch ? lc(speciesMatch[1]) : null;

    const variety = pickVariety(t, species || "");

    const days =
      t.match(RX.days)?.[1] || t.match(RX.dttm)?.[1]
        ? Number(t.match(RX.days)?.[1] || t.match(RX.dttm)?.[1])
        : null;

    const depthM = t.match(RX.depth)?.[1] || null;
    const spacingM = t.match(RX.spacing)?.[1] || null;
    const rowSpacingM = t.match(RX.rowSpacing)?.[1] || null;
    const heightM = t.match(RX.height)?.[1] || null;

    const sun = t.match(RX.sun)?.[1] || null;

    const startIndoorsWeeks = t.match(RX.startIndoors)?.[1]
      ? Number(t.match(RX.startIndoors)[1])
      : null;
    const transplantAfterFrost = !!t.match(RX.afterFrost);

    const zoneM = t.match(RX.zone);
    const zoneMin = zoneM ? Number(zoneM[1]) : null;
    const zoneMax = zoneM && zoneM[2] ? Number(zoneM[2]) : zoneMin;

    const packedFor = t.match(RX.packed)?.[1] || null;
    const lot = t.match(RX.lot)?.[1] || null;

    const weight = t.match(RX.weight)?.[1] || null;

    const depth = depthM ? parseMeasure(depthM) : { qty: null, unit: null };
    const spacing = spacingM
      ? parseMeasure(spacingM)
      : { qty: null, unit: null };
    const rowSpacing = rowSpacingM
      ? parseMeasure(rowSpacingM)
      : { qty: null, unit: null };
    const height = heightM ? parseMeasure(heightM) : { qty: null, unit: null };

    // sow hint
    const sowHint = t.match(RX.sow)?.[1] || null;
    const sowMethod = sowHint
      ? lc(sowHint).includes("direct")
        ? "direct"
        : lc(sowHint).includes("indoors")
        ? "indoors"
        : lc(sowHint).includes("transplant")
        ? "transplant"
        : null
      : null;

    return {
      brand: brand && brand.length ? brand : null,
      species,
      variety,
      daysToMaturity: Number.isFinite(days) ? days : null,
      depth,
      spacing,
      rowSpacing,
      height,
      sun: sun ? lc(sun) : null,
      startIndoorsWeeksBeforeFrost: startIndoorsWeeks,
      transplantAfterFrost,
      zoneMin,
      zoneMax,
      packedForYear: packedFor ? Number(packedFor) : null,
      lot: lot || null,
      weight,
      sowMethod,
      rawText: t,
    };
  }

  /* ------------------------------ OCR execution ----------------------------- */
  // We accept an injected ocr(text|image) function via ctx. If not provided and only
  // image is present, we return an error; if ocrText is provided, we skip OCR.
  async function runOCR(input, ctx) {
    if (input.ocrText) return { ok: true, text: cleanOCR(input.ocrText) };
    if (!input.image && !input.dataUrl) return { ok: false, error: "no-input" };

    const fn = ctx?.ocr || ctx?.ocrFn; // expected signature: async (image|dataUrl) => "text"
    if (typeof fn !== "function") return { ok: false, error: "no-ocr-fn" };

    try {
      const text = await fn(input.image || input.dataUrl);
      if (!text || !toStr(text)) return { ok: false, error: "ocr-empty" };
      return { ok: true, text: cleanOCR(text) };
    } catch (e) {
      return { ok: false, error: String(e?.message || e) };
    }
  }

  /* ------------------------- mapping to normalized shape -------------------- */
  function toNormalizedSeed(seed, meta = {}) {
    // Use the central normalizer so the rest of the pipeline stays consistent.
    if (normalize?.normalizeFromProvider) {
      const cats = uniq([
        "garden:seed",
        seed.species ? `seed:${seed.species}` : null,
        seed.sun ? `sun:${seed.sun.replace(/\s+/g, "-")}` : null,
        seed.zoneMin != null && seed.zoneMax != null
          ? `zone:${seed.zoneMin}-${seed.zoneMax}`
          : null,
      ]);

      const name =
        [seed.variety, seed.species].filter(Boolean).map(toStr).join(" — ") ||
        seed.variety ||
        seed.species ||
        "Seed Packet";

      const descBits = [];
      if (seed.daysToMaturity) descBits.push(`${seed.daysToMaturity} days`);
      if (seed.sowMethod) descBits.push(seed.sowMethod);
      const variant = descBits.join(" · ") || null;

      const norm = normalize.normalizeFromProvider(
        "ocr:seed",
        {
          upc: null, // no UPC
          brand: seed.brand ? toStr(seed.brand) : null,
          name,
          variant,
          // We don't force size on seeds; many packets include weight; treat as "ea"
          size: seed.weight || "1 packet",
          ingredients: [],
          categories: cats,
          images: [], // keep empty; UI will keep the uploaded image separately
          nutrition: null,
          warnings: [], // none; safety rules can flag based on herb/edible later if needed
          offers: [], // pricing isn't available; your PriceBook may fill later if the user enters cost
        },
        {
          trust: 0.62,
          label: "OCR Seed Packet",
          url: null,
          sessionId: meta.sessionId || null,
          sessionLabel: meta.sessionLabel || null,
        }
      );

      // Attach garden-specific meta under source-specific extension (non-breaking)
      norm.meta = {
        provider: "ocr:seed",
        species: seed.species,
        variety: seed.variety,
        daysToMaturity: seed.daysToMaturity,
        depth: seed.depth,
        spacing: seed.spacing,
        rowSpacing: seed.rowSpacing,
        height: seed.height,
        sun: seed.sun,
        sowMethod: seed.sowMethod,
        startIndoorsWeeksBeforeFrost: seed.startIndoorsWeeksBeforeFrost,
        transplantAfterFrost: seed.transplantAfterFrost,
        zoneMin: seed.zoneMin,
        zoneMax: seed.zoneMax,
        packedForYear: seed.packedForYear,
        lot: seed.lot,
        weight: seed.weight,
        ocrPreview: seed.rawText?.slice(0, 400) || null,
      };

      return norm;
    }

    // Minimal fallback if normalizer unavailable
    return {
      upc: null,
      brand: seed.brand || null,
      name:
        [seed.variety, seed.species].filter(Boolean).join(" — ") ||
        "Seed Packet",
      sizeQty: 1,
      sizeUnit: "ea",
      ingredients: [],
      categories: ["garden:seed"],
      images: [],
      nutrition: null,
      warnings: [],
      offers: [],
      price: null,
      source: { key: "ocr:seed", label: "OCR Seed Packet", trust: 0.62 },
      sessionId: meta.sessionId || null,
      sessionLabel: meta.sessionLabel || null,
      observedISO: nowISO(),
      meta: { ...seed },
    };
  }

  /* --------------------------------- lookup --------------------------------- */
  /**
   * lookup(query, ctx?)
   * query:  { image?:Blob|File, dataUrl?:string, ocrText?:string, sessionId?, sessionLabel? }
   * ctx:    { ocr?:fn(image|dataUrl)=>Promise<string>, force?:boolean }
   * return: { ok, product, raw }  where raw = { text, seed }
   */
  async function lookup(query = {}, ctx = {}) {
    // 1) OCR (or provided text)
    const ocr = await runOCR(query, ctx);
    if (!ocr.ok) {
      eventBus.emit?.("product:provider:fail", {
        provider: "ocr:seed",
        error: ocr.error,
      });
      return { ok: false, error: ocr.error };
    }

    const text = ocr.text;
    const key = `seed:${tinyHash(text)}`;
    if (!ctx.force) {
      const cached = await cacheGet(key);
      if (cached) {
        eventBus.emit?.("product:provider:cache_hit", {
          provider: "ocr:seed",
          key,
        });
        return {
          ok: true,
          product: cached.product,
          raw: cached.raw,
          cached: true,
        };
      }
    }

    eventBus.emit?.("product:provider:query", {
      provider: "ocr:seed",
      bytes: query.image?.size || 0,
    });

    // 2) Parse fields
    const seedMeta = parseSeedMeta(text);

    // 3) Map to normalized shape
    const product = toNormalizedSeed(seedMeta, {
      sessionId: query.sessionId,
      sessionLabel: query.sessionLabel,
    });
    const raw = { text, seed: seedMeta };

    // 4) Persist cache & emit events
    await cachePut(key, { product, raw });
    eventBus.emit?.("product:provider:ok", {
      provider: "ocr:seed",
      variety: seedMeta.variety,
      species: seedMeta.species,
    });
    eventBus.emit?.("garden:seed:parsed", {
      variety: seedMeta.variety,
      species: seedMeta.species,
      daysToMaturity: seedMeta.daysToMaturity,
      sun: seedMeta.sun,
      spacing: seedMeta.spacing,
      depth: seedMeta.depth,
      zoneMin: seedMeta.zoneMin,
      zoneMax: seedMeta.zoneMax,
      sessionId: product.sessionId,
      sessionLabel: product.sessionLabel,
    });

    // Optionally hint a Garden session template (planner can listen)
    eventBus.emit?.("session:template:proposed", {
      template: {
        id: `garden-seed-${Date.now()}`,
        domain: "garden",
        label: `Start ${seedMeta.variety || seedMeta.species || "seed"}`,
        schedule: [], // let UI attach preferred schedule / quiet-hours checks
        preferences: {
          species: seedMeta.species || null,
          variety: seedMeta.variety || null,
          daysToMaturity: seedMeta.daysToMaturity || null,
          sowMethod: seedMeta.sowMethod || null,
          startIndoorsWeeksBeforeFrost:
            seedMeta.startIndoorsWeeksBeforeFrost || null,
          transplantAfterFrost: seedMeta.transplantAfterFrost || null,
          spacingInches: seedMeta.spacing?.unit?.startsWith("in")
            ? seedMeta.spacing.qty
            : null,
          depthInches: seedMeta.depth?.unit?.startsWith("in")
            ? seedMeta.depth.qty
            : null,
          zone:
            seedMeta.zoneMin != null && seedMeta.zoneMax != null
              ? `${seedMeta.zoneMin}-${seedMeta.zoneMax}`
              : null,
          sun: seedMeta.sun || null,
        },
        createdISO: nowISO(),
      },
    });

    return { ok: true, product, raw };
  }

  /* ----------------------------- registry helper ---------------------------- */
  /**
   * registerWithResolver(resolver, meta?)
   * Register with ProductResolver so OCR "product" can be merged or used standalone.
   */
  function registerWithResolver(resolver, meta) {
    const api =
      resolver ||
      (ProductResolver &&
        ProductResolver.createProductResolver &&
        ProductResolver.createProductResolver());
    if (!api || !api.registerProviderAdapter) return false;
    return api.registerProviderAdapter(
      "ocr:seed",
      lookup,
      Object.assign(
        {
          trust: 0.62,
          timeoutMs: 15000, // allow OCR time; actual depends on your OCR fn
          rateLimitMs: 0,
          label: "OCR Seed Packet",
        },
        meta || {}
      )
    );
  }

  /* --------------------------------- exports -------------------------------- */
  var out = {
    lookup,
    registerWithResolver,
    __util: { parseSeedMeta, cleanOCR, tinyHash },
  };

  try {
    module.exports = out;
  } catch (_e) {}
  try {
    (globalThis || window).OCRSeedPacketProvider = out;
  } catch (_e) {}
})();
