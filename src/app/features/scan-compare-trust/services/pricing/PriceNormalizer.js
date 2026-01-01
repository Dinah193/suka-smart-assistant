/* eslint-disable no-console */
// C:\Users\larho\suka-smart-assistant\src\app\features\scan-compare-trust\services\pricing\PriceNormalizer.js
// Unit parsing + conversion + pack math (mass, volume, count), prefs-aware.
// ✅ Update: adds grocery unit-price normalization (oz/lb/unit) + store/location dimension
//
// Normalizer API (existing + additive):
//  - parseSizeText("2 x 12 fl oz") -> { qty:12, uom:"floz", packCount:2, parsedFrom:"text" }
//  - normalizeDim({qty,uom,packCount}) -> { domain, baseQty, baseUom }
//  - convert({qty,uom}, "g") -> { qty,uom }
//  - coerceOfferSize(offer) -> normalized dim
//  - NEW: normalizeObservationForUnitPrice(observation, ctx) -> observation + unitPriceNormalized
//  - NEW: normalizeUnitPrice({price, sizeText|dim, targetUnit}) -> { unitPrice, unitLabel, perQty, perUom }
//  - NEW: buildStoreKey({store, placeId, locationId}) -> stable store key
//
// Notes:
//  - Dependency-light; adapters optional (prefs/config/eventBus/analytics).
//  - Safe fallbacks (local memory) for storage.
//  - Emits: "pricing:normalizer:*"
//
// IMPORTANT:
//  - This file does NOT require Tailwind.
//  - Store/location dimension is returned as: storeKey + (store, placeId, locationId) echoed.

export function createPriceNormalizer(deps = {}) {
  const {
    prefs = safePrefs(),
    config = safeConfig(),
    eventBus = safeBus(),
    analytics = safeAnalytics(),
  } = deps;

  const NS = "scanCompareTrust.pricing.normalizer";
  const PROFILE_KEY = `${NS}.profile.v2`;
  const FAVS_KEY = `${NS}.favorites.v2`;

  let profile = hydrateProfile();
  let favorites = hydrateFavorites();

  // ---------- Public API ----------
  return {
    // Parsing & normalization
    parseSizeText,
    normalizeDim,
    convert,
    coerceOfferSize,
    inferDomain,

    // ✅ Grocery unit price helpers (NEW)
    normalizeUnitPrice,
    normalizeObservationForUnitPrice,
    buildStoreKey,
    normalizeStoreContext,

    // Profile management
    getActiveProfile,
    setActiveProfile,
    exportProfile,
    importProfile,
    listFavoriteProfiles,
    saveFavoriteProfile,
    removeFavoriteProfile,

    // Tables / diagnostics
    getUomTables,
    getVersion,
  };

  function getVersion() {
    return "2.1.0";
  }

  // ---------------------- Parsing ----------------------

  /**
   * Parse size text like "2 x 12 fl oz", "1 qt (32 fl oz)", "3lb", "500 g", "4ct", "Family Pack 3 lb".
   * Returns normalized { qty, uom, packCount, parsedFrom, notes[] }.
   */
  function parseSizeText(sizeText = "") {
    const s = String(sizeText || "")
      .toLowerCase()
      .trim();
    if (!s)
      return {
        qty: 1,
        uom: "unit",
        packCount: 1,
        parsedFrom: "fallback",
        notes: ["empty size"],
      };

    // detect pack pattern: "2 x " / "2x" / "2×"
    const packRx = /(\d+(?:\.\d+)?)\s*[x×]\s*/i;
    let packCount = 1;
    let rest = s;
    const pm = s.match(packRx);
    if (pm) {
      packCount = Number(pm[1]);
      rest = s.replace(packRx, "");
    }

    // qty + uom
    const partsRx =
      /(\d+(?:\.\d+)?)\s*(fl\s*oz|fluid\s*ounce[s]?|oz|ounce[s]?|lb|pound[s]?|g|gram[s]?|kg|kilogram[s]?|l|liter[s]?|litre[s]?|ml|milliliter[s]?|millilitre[s]?|qt|quart[s]?|ct|count|each|ea|gal|gallon[s]?)/i;
    const m = rest.match(partsRx);

    if (!m) {
      // Count variant "6 count", "4ct", or bare number at start likely count
      const cRx = /(\d+)\s*(ct|count|each|ea)\b/i;
      const cm = rest.match(cRx) || rest.match(/^(\d+)\b/);
      if (cm) {
        const q = Number(cm[1]);
        return {
          qty: q,
          uom: "ct",
          packCount: 1,
          parsedFrom: "text",
          notes: ["count-only"],
        };
      }
      return {
        qty: 1,
        uom: "unit",
        packCount: 1,
        parsedFrom: "fallback",
        notes: ["unparsed"],
      };
    }

    let qty = Number(m[1]);
    let uom = normalizeUom(m[2]);

    // Prefer parenthetical sub-size if present, e.g. "1 qt (32 fl oz)" → 32 fl oz
    const parenRx = /\(([^)]+)\)/g;
    let match;
    let parenthetical = null;
    while ((match = parenRx.exec(rest))) {
      const pm2 = match[1].match(partsRx);
      if (pm2)
        parenthetical = { qty: Number(pm2[1]), uom: normalizeUom(pm2[2]) };
    }
    if (parenthetical) {
      qty = parenthetical.qty;
      uom = parenthetical.uom;
    }

    return { qty, uom, packCount, parsedFrom: "text", notes: [] };
  }

  // ------------------- Normalization & Conversion -------------------

  /**
   * Normalize to base unit per domain:
   *  - mass   → grams (g)
   *  - volume → milliliters (mL)
   *  - count  → ct
   */
  function normalizeDim(dim) {
    const d = materializeDim(dim);
    const domain = inferDomain(d.uom);
    const qtyTotal = d.qty * (d.packCount || 1);

    if (domain === "mass") {
      return {
        domain,
        baseQty: qtyTotal * MASS_TO_G[d.uom],
        baseUom: "g",
        packCount: d.packCount,
        parsedFrom: d.parsedFrom,
        notes: d.notes,
      };
    }
    if (domain === "volume") {
      return {
        domain,
        baseQty: qtyTotal * VOL_TO_ML[d.uom],
        baseUom: "mL",
        packCount: d.packCount,
        parsedFrom: d.parsedFrom,
        notes: d.notes,
      };
    }
    if (domain === "count") {
      return {
        domain,
        baseQty: qtyTotal,
        baseUom: "ct",
        packCount: d.packCount,
        parsedFrom: d.parsedFrom,
        notes: d.notes,
      };
    }
    return {
      domain: "unknown",
      baseQty: qtyTotal,
      baseUom: "unit",
      packCount: d.packCount,
      parsedFrom: d.parsedFrom,
      notes: [...(d.notes || []), "unknown uom"],
    };
  }

  /**
   * Convert between supported UOMs with optional density maps for count→mass/volume.
   */
  function convert(source, targetUom, ctx = {}) {
    const from = materializeDim({ ...source, packCount: 1 });
    const to = normalizeUom(targetUom);
    const fromDomain = inferDomain(from.uom);
    const toDomain = inferDomain(to);

    // Same domain direct conversion
    if (fromDomain === "mass" && toDomain === "mass") {
      const g = from.qty * MASS_TO_G[from.uom];
      const out = { qty: g / (MASS_TO_G[to] || 1), uom: to };
      emitConverted(from, to, out, ctx);
      return out;
    }
    if (fromDomain === "volume" && toDomain === "volume") {
      const ml = from.qty * VOL_TO_ML[from.uom];
      const out = { qty: ml / (VOL_TO_ML[to] || 1), uom: to };
      emitConverted(from, to, out, ctx);
      return out;
    }
    if (fromDomain === "count" && toDomain === "count") {
      const out = { qty: from.qty, uom: to };
      emitConverted(from, to, out, ctx);
      return out;
    }

    // Cross-domain via density maps or product hints
    const density = pickDensity(ctx);
    if (fromDomain === "count" && toDomain === "mass" && density?.massPerCtG) {
      const g = from.qty * density.massPerCtG;
      const out = { qty: g / (MASS_TO_G[to] || 1), uom: to };
      emitConverted(from, to, out, ctx);
      return out;
    }
    if (fromDomain === "count" && toDomain === "volume" && density?.mlPerCt) {
      const ml = from.qty * density.mlPerCt;
      const out = { qty: ml / (VOL_TO_ML[to] || 1), uom: to };
      emitConverted(from, to, out, ctx);
      return out;
    }
    if (fromDomain === "volume" && toDomain === "mass" && density?.gPerMl) {
      const g = from.qty * VOL_TO_ML[from.uom] * density.gPerMl;
      const out = { qty: g / (MASS_TO_G[to] || 1), uom: to };
      emitConverted(from, to, out, ctx);
      return out;
    }
    if (fromDomain === "mass" && toDomain === "volume" && density?.mlPerG) {
      const ml = from.qty * MASS_TO_G[from.uom] * density.mlPerG;
      const out = { qty: ml / (VOL_TO_ML[to] || 1), uom: to };
      emitConverted(from, to, out, ctx);
      return out;
    }

    // Unsupported cross-domain
    const fallback = { qty: NaN, uom: to };
    emitConverted(from, to, fallback, ctx);
    return fallback;
  }

  /**
   * Coerce an offer to normalized base units.
   */
  function coerceOfferSize(offer = {}) {
    let dim;
    if (offer.unit?.qty && offer.unit?.uom) {
      dim = materializeDim({
        qty: Number(offer.unit.qty),
        uom: normalizeUom(offer.unit.uom),
        packCount:
          Number(offer.unit.packCount || inferPackFrom(offer.title)) || 1,
        parsedFrom: "unit",
      });
    } else {
      dim = parseSizeText(offer.sizeText || offer.title || "");
    }
    const norm = normalizeDim(dim);
    eventBus.emit("pricing:normalizer:parsed", {
      offerId: offer.id,
      dim,
      normalized: norm,
      ts: Date.now(),
    });
    analytics.track?.("normalizer_parsed", {
      offerId: offer.id,
      domain: norm.domain,
    });
    return norm;
  }

  // ───────────────────────────── NEW: Unit-price normalization ─────────────────────────────

  /**
   * Normalize unit price for groceries into a consistent target unit:
   *  - mass → "$/oz" OR "$/lb"
   *  - volume → "$/fl oz" OR "$/mL"
   *  - count → "$/unit"
   *
   * Inputs:
   *  { price, currency, sizeText?, dim?, targetUnit? }
   *
   * Output:
   *  { unitPrice, unitLabel, perQty, perUom, domain, baseQty, baseUom }
   */
  function normalizeUnitPrice(input = {}, ctx = {}) {
    const price = toNum(input.price);
    if (price == null) return null;

    const currency = input.currency || "USD";
    let dim = input.dim;

    if (!dim && input.sizeText) dim = parseSizeText(input.sizeText);
    if (!dim && ctx?.item?.size) dim = parseSizeText(ctx.item.size);
    if (!dim)
      dim = { qty: 1, uom: "unit", packCount: 1, parsedFrom: "fallback" };

    const normalized = normalizeDim(dim);
    const domain = normalized.domain;

    // default targets (grocery-friendly)
    const target = normalizeUom(
      input.targetUnit ||
        (domain === "mass"
          ? defaultMassUnitTarget()
          : domain === "volume"
          ? "floz"
          : "unit")
    );

    const per = unitPriceFromNormalized(price, normalized, target);
    if (!per) return null;

    return {
      unitPrice: per.unitPrice,
      unitLabel: `${formatMoney(per.unitPrice, currency)}/${per.perUomLabel}`,
      perQty: per.perQty,
      perUom: per.perUom,
      perUomLabel: per.perUomLabel,
      currency,
      domain,
      baseQty: normalized.baseQty,
      baseUom: normalized.baseUom,
    };
  }

  /**
   * Takes an observation and attaches:
   *  - storeKey / store context
   *  - unitPriceNormalized (computed if size info is available)
   */
  function normalizeObservationForUnitPrice(observation = {}, ctx = {}) {
    const o = normalizeObservation(observation);

    const storeCtx = normalizeStoreContext({
      store: o.store,
      placeId:
        observation.placeId || observation.place_id || ctx?.store?.placeId,
      locationId:
        observation.locationId ||
        observation.location_id ||
        ctx?.store?.locationId,
      storeId:
        observation.storeId || observation.store_id || ctx?.store?.storeId,
    });

    const sizeText =
      observation.sizeText ||
      observation.size_text ||
      ctx?.item?.size ||
      ctx?.item?.sizeText ||
      null;

    const out = {
      ...o,
      ...storeCtx,
    };

    // Only compute unit price if we have price + size hint
    if (out.price != null && sizeText) {
      const nup = normalizeUnitPrice(
        {
          price: out.price,
          currency: out.currency,
          sizeText,
          targetUnit: ctx?.targetUnit,
        },
        ctx
      );
      if (nup) {
        out.unitPriceNormalized = {
          unitPrice: nup.unitPrice,
          perQty: nup.perQty,
          perUom: nup.perUom,
          perUomLabel: nup.perUomLabel,
          label: nup.unitLabel,
          domain: nup.domain,
        };
      }
    }

    // emit (optional)
    eventBus.emit?.("pricing:normalizer:observation", {
      storeKey: out.storeKey,
      upc: ctx?.item?.upc || ctx?.upc || null,
      observation: out,
      ts: Date.now(),
    });

    return out;
  }

  function normalizeStoreContext(storeCtx = {}) {
    const store = String(storeCtx.store || "").trim() || null;
    const placeId = String(storeCtx.placeId || "").trim() || null;
    const locationId = String(storeCtx.locationId || "").trim() || null;
    const storeId = String(storeCtx.storeId || "").trim() || null;

    const storeKey = buildStoreKey({ store, placeId, locationId, storeId });

    return { store, placeId, locationId, storeId, storeKey };
  }

  /**
   * Stable store key:
   *  - prefer placeId if present
   *  - else locationId/storeId
   *  - else store chain name
   */
  function buildStoreKey({ store, placeId, locationId, storeId } = {}) {
    if (placeId) return `place:${String(placeId)}`;
    if (locationId) return `loc:${String(locationId)}`;
    if (storeId) return `store:${String(storeId)}`;
    if (store) return `chain:${normStore(store)}`;
    return "store:unknown";
  }

  function defaultMassUnitTarget() {
    // Household preference can override: pricing.unitTarget.mass = "lb"|"oz"
    const pref = config.get?.("pricing.unitTarget.mass", null);
    const p = String(pref || "")
      .toLowerCase()
      .trim();
    if (p === "lb" || p === "oz") return p;
    // generally: groceries compare best at $/oz; meats sometimes $/lb
    return "oz";
  }

  function unitPriceFromNormalized(price, normalized, targetUom) {
    const domain = normalized?.domain;

    if (domain === "mass") {
      // base is grams
      const target = normalizeUom(targetUom || "oz"); // "oz" or "lb"
      const grams = toNum(normalized.baseQty);
      if (!grams || grams <= 0) return null;

      // grams -> target
      const gramsPerTarget = target === "lb" ? MASS_TO_G.lb : MASS_TO_G.oz;
      const qtyInTarget = grams / gramsPerTarget;
      if (!qtyInTarget || qtyInTarget <= 0) return null;

      return {
        unitPrice: price / qtyInTarget,
        perQty: 1,
        perUom: target,
        perUomLabel: target === "lb" ? "lb" : "oz",
      };
    }

    if (domain === "volume") {
      // base is mL
      const target = normalizeUom(targetUom || "floz"); // floz or ml
      const ml = toNum(normalized.baseQty);
      if (!ml || ml <= 0) return null;

      let qtyInTarget = ml;
      let perUomLabel = "mL";
      if (target === "floz") {
        qtyInTarget = ml / VOL_TO_ML.floz;
        perUomLabel = "fl oz";
      } else if (target === "ml") {
        qtyInTarget = ml;
        perUomLabel = "mL";
      } else if (target === "l") {
        qtyInTarget = ml / 1000;
        perUomLabel = "L";
      }

      if (!qtyInTarget || qtyInTarget <= 0) return null;

      return {
        unitPrice: price / qtyInTarget,
        perQty: 1,
        perUom: target,
        perUomLabel,
      };
    }

    // count or unknown
    const base = toNum(normalized.baseQty);
    if (!base || base <= 0) return null;
    return {
      unitPrice: price / base,
      perQty: 1,
      perUom: "unit",
      perUomLabel: "unit",
    };
  }

  // ------------------- Profile (user presets) -------------------

  function getActiveProfile() {
    return profile;
  }

  function setActiveProfile(p) {
    profile = materializeProfile(p);
    persistProfile(profile);
    eventBus.emit("pricing:normalizer:profile:activated", {
      profileId: profile.id,
      ts: Date.now(),
    });
  }

  function exportProfile() {
    return JSON.parse(JSON.stringify(profile));
  }

  function importProfile(p) {
    profile = materializeProfile(p);
    persistProfile(profile);
    eventBus.emit("pricing:normalizer:profile:imported", {
      profileId: profile.id,
      ts: Date.now(),
    });
    return true;
  }

  function listFavoriteProfiles() {
    return favorites.slice();
  }

  function saveFavoriteProfile(label) {
    const snap = JSON.parse(JSON.stringify(profile));
    snap.id = `norm:fav:${Date.now()}`;
    snap.label = label || `${profile.label} ★ Favorite`;
    favorites.push(snap);
    persistFavorites(favorites);
    eventBus.emit("pricing:normalizer:profile:favorited", {
      profileId: snap.id,
      ts: Date.now(),
    });
    return snap.id;
  }

  function removeFavoriteProfile(profileId) {
    const before = favorites.length;
    favorites = favorites.filter((f) => f.id !== profileId);
    if (favorites.length !== before) {
      persistFavorites(favorites);
      eventBus.emit("pricing:normalizer:profile:favorite:removed", {
        profileId,
        ts: Date.now(),
      });
      return true;
    }
    return false;
  }

  // ------------------- Helpers & Tables -------------------

  function inferDomain(uom) {
    if (MASS_TO_G[uom]) return "mass";
    if (VOL_TO_ML[uom]) return "volume";
    if (COUNT_UOM[uom]) return "count";
    if (uom === "unit") return "count";
    return "unknown";
  }

  function normalizeUom(u) {
    const s = String(u || "")
      .toLowerCase()
      .replace(/\./g, "")
      .trim();
    if (s === "ounces" || s === "ounce") return "oz";
    if (s === "pounds" || s === "pound") return "lb";
    if (
      s === "fluid ounces" ||
      s === "fluid ounce" ||
      s === "fluidounce" ||
      s === "fluidounces" ||
      s === "fl oz" ||
      s === "floz"
    )
      return "floz";
    if (s === "liters" || s === "litres" || s === "liter" || s === "litre")
      return "l";
    if (
      s === "milliliters" ||
      s === "millilitres" ||
      s === "milliliter" ||
      s === "millilitre"
    )
      return "ml";
    if (s === "grams" || s === "gram") return "g";
    if (s === "kilograms" || s === "kilogram") return "kg";
    if (s === "quart" || s === "quarts") return "qt";
    if (s === "count" || s === "each" || s === "ea") return "ct";
    if (s === "gallons" || s === "gallon") return "gal";
    return s;
  }

  const MASS_TO_G = Object.freeze({
    g: 1,
    kg: 1000,
    oz: 28.349523125,
    lb: 453.59237,
  });

  const VOL_TO_ML = Object.freeze({
    ml: 1,
    l: 1000,
    floz: 29.5735295625,
    qt: 946.352946,
    gal: 3785.411784,
  });

  const COUNT_UOM = Object.freeze({
    ct: 1,
    unit: 1,
  });

  function getUomTables() {
    return {
      MASS_TO_G: { ...MASS_TO_G },
      VOL_TO_ML: { ...VOL_TO_ML },
      COUNT_UOM: { ...COUNT_UOM },
    };
  }

  function materializeDim(d) {
    return {
      qty: Number(d?.qty || 1),
      uom: normalizeUom(d?.uom || "unit"),
      packCount: Number(d?.packCount || 1),
      parsedFrom: d?.parsedFrom || "unit",
      notes: Array.isArray(d?.notes) ? d.notes : [],
    };
  }

  function inferPackFrom(title = "") {
    const m = String(title || "")
      .toLowerCase()
      .match(/(\d+(?:\.\d+)?)\s*[x×]\s*/i);
    return m ? Number(m[1]) : 1;
  }

  function pickDensity(ctx) {
    const direct = ctx?.density;
    const fromMap = ctx?.densityMap && ctx.sku ? ctx.densityMap[ctx.sku] : null;
    const globalDefault = config.get?.("pricing.densityMap.default", null);
    return direct || fromMap || globalDefault || null;
  }

  function emitConverted(from, targetUom, out, ctx) {
    eventBus.emit("pricing:normalizer:converted", {
      from,
      to: targetUom,
      out,
      meta: { sku: ctx?.sku || null },
      ts: Date.now(),
    });
    analytics.track?.("normalizer_converted", {
      from: from.uom,
      to: targetUom,
      ok: Number.isFinite(out.qty),
    });
  }

  // ------------------- Observation normalization (internal) -------------------

  function normalizeObservation(o) {
    if (!o || typeof o !== "object") return {};
    return {
      store: o.store || o.retailer || o.market || "",
      price: toNum(o.price),
      unitPrice: toNum(o.unitPrice || o.unit_price),
      unit: o.unit || o.unitLabel || o.unit_label || null,
      currency: o.currency || "USD",
      inStock: typeof o.inStock === "boolean" ? o.inStock : o.in_stock,
      at: o.at || o.ts || o.observedAt || o.observed_at || null,
      source: o.source || o.provider || null,
      confidence: toNum(o.confidence),
    };
  }

  // ------------------- Formatting -------------------

  function formatMoney(value, currency = "USD") {
    const n = Number(value);
    if (!Number.isFinite(n)) return "";
    try {
      return new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: String(currency || "USD"),
        maximumFractionDigits: 2,
      }).format(n);
    } catch {
      return `$${n.toFixed(2)}`;
    }
  }

  function normStore(s) {
    return String(s || "")
      .trim()
      .toLowerCase();
  }

  function toNum(x) {
    const n = Number(x);
    return Number.isFinite(n) ? n : null;
  }

  // ------------------- Profiles (prefs) -------------------

  function hydrateProfile() {
    const stored = prefs.get(PROFILE_KEY);
    if (stored) return materializeProfile(stored);
    const p = defaultProfile();
    persistProfile(p);
    return p;
  }
  function persistProfile(p) {
    try {
      prefs.set(PROFILE_KEY, p);
    } catch (e) {
      console.warn("[PriceNormalizer] persistProfile", e);
    }
  }

  function hydrateFavorites() {
    return prefs.get(FAVS_KEY) || [];
  }
  function persistFavorites(arr) {
    try {
      prefs.set(FAVS_KEY, arr);
    } catch (e) {
      console.warn("[PriceNormalizer] persistFavorites", e);
    }
  }

  function materializeProfile(p) {
    return {
      id: p.id || `norm:profile:${Date.now()}`,
      label: p.label || "Household Normalization",
      preferredSystem: p.preferredSystem || "auto",
      showPerHundred: {
        mass:
          p.showPerHundred && typeof p.showPerHundred.mass !== "undefined"
            ? p.showPerHundred.mass
            : true,
        volume:
          p.showPerHundred && typeof p.showPerHundred.volume !== "undefined"
            ? p.showPerHundred.volume
            : true,
      },
      defaultDensities: p.defaultDensities || {
        water: { gPerMl: 1.0, mlPerG: 1.0 },
      },
    };
  }

  function defaultProfile() {
    return {
      id: `norm:profile:${Date.now()}`,
      label: "Household Normalization",
      preferredSystem: "auto",
      showPerHundred: { mass: true, volume: true },
      defaultDensities: { water: { gPerMl: 1.0, mlPerG: 1.0 } },
    };
  }

  // ------------------- Safe Adapters -------------------

  function safePrefs() {
    let mem = {};
    let ok = false;
    try {
      localStorage.setItem("__pn_probe", "1");
      localStorage.removeItem("__pn_probe");
      ok = true;
    } catch (_) {}
    return {
      get(k) {
        if (ok) {
          const raw = localStorage.getItem(k);
          return raw ? JSON.parse(raw) : null;
        }
        return mem[k] || null;
      },
      set(k, v) {
        if (ok) localStorage.setItem(k, JSON.stringify(v));
        else mem[k] = v;
      },
    };
  }
  function safeConfig() {
    return { get: (_p, fb) => fb };
  }
  function safeBus() {
    return { emit: () => {} };
  }
  function safeAnalytics() {
    return { track: () => {} };
  }
}

// --------- Singleton convenience ---------
let __priceNormalizerSingleton;
export function getPriceNormalizerSingleton(deps) {
  if (!__priceNormalizerSingleton)
    __priceNormalizerSingleton = createPriceNormalizer(deps);
  return __priceNormalizerSingleton;
}
