/* eslint-disable no-console */
// src/features/scan-compare-trust/services/pricing/PriceComparator.js
// Unit normalization + ranking for multi-source price offers, pack-sizes, mass/volume/count.
// Dependency-light, event-driven, prefs-aware; safe fallbacks for adapters.

/**
 * INPUT SHAPE (offer):
 * {
 *   id: string,
 *   title: string,
 *   store: { id:string, name:string, loyaltyTier?: "member"|"plus"|null, distanceKm?:number },
 *   price: { amount:number, currency:"USD"|string, includesTax?:boolean, taxRate?:number },
 *   sizeText?: string,            // e.g., "2 x 12 fl oz", "1 qt", "3 lb", "500 g", "4ct"
 *   unit?: { qty:number, uom:string }, // optional structured size; preferred over sizeText
 *   category?: "grocery"|"household"|"cosmetics"|"garden"|"baby"|string,
 *   availability?: "in_stock"|"limited"|"oos",
 *   metadata?: any
 * }
 *
 * OUTPUT SHAPE (ranked result):
 * {
 *   offers: Array<{
 *     ...input,
 *     _normalized: {
 *       domain: "mass"|"volume"|"count"|"unknown",
 *       baseQty: number,           // in base unit (g / mL / count)
 *       baseUom: "g"|"mL"|"ct"|"unit",
 *       packCount: number,
 *       parsedFrom: "unit"|"text"|"fallback",
 *       notes?: string[]
 *     },
 *     unitPrice: { amount:number, per:"100g"|"100mL"|"ct"|"g"|"mL" },
 *     effectivePrice: { amount:number, reason:string }, // after prefs tax handling + store membership
 *     score: number,               // higher is better for ranking
 *     rank: number
 *   }>,
 *   best: offer|null,
 *   profileId: string,
 *   profileLabel: string,
 *   strategy: "per100g"|"per100mL"|"perUnit"|"auto",
 * }
 */

export function createPriceComparator(deps = {}) {
  const {
    prefs = safePrefs(),
    config = safeConfig(),
    eventBus = safeBus(),
    analytics = safeAnalytics(),
    currency = safeCurrency(), // { toMajor(amount, currency):number, format(amount,currency):string }
  } = deps;

  const NS = "scanCompareTrust.pricing";
  const PREF_KEY = `${NS}.profile.v2`;
  const FAVORITES_KEY = `${NS}.favoriteProfiles.v2`;

  // ---- load profile(s) ----
  let profile = hydrateActiveProfile();
  let favorites = hydrateFavorites();

  return {
    // Compare & rank
    compareOffers,

    // Profile
    getActiveProfile,
    setActiveProfile,
    exportProfile,
    importProfile,
    listFavoriteProfiles,
    saveFavoriteProfile,
    removeFavoriteProfile,

    // Utils
    parseSize,
    normalizeToBase,
    unitPriceFor,
    getVersion,
  };

  function getVersion() {
    return "2.1.0";
  }

  // ------------------- PUBLIC: compare -------------------

  /**
   * @param {Array<Object>} offers
   * @param {Object} [ctx]
   * @param {"per100g"|"per100mL"|"perUnit"|"auto"} [ctx.strategy]
   * @returns {Object} ranked
   */
  function compareOffers(offers = [], ctx = {}) {
    const strategy = ctx.strategy || profile.strategy || "auto";
    const userBaseUnits = profile.baseUnits || DEFAULT_BASE_UNITS;
    const storeWeights = profile.storeWeights || {};
    const loyaltyPriorities = profile.loyaltyPriorities || DEFAULT_LOYALTY_PRIORITIES;

    const normalized = offers.map((off) => {
      const parsed = coerceToBase(off);
      const per = pickPer(strategy, parsed.domain, userBaseUnits);
      const eff = applyEffectivePrice(off.price, off.store, profile);
      const unitPrice = computeUnitPrice(eff.amount, per, parsed.baseQty);

      // availability + store distance + loyalty weighting
      const availabilityScore = AVAILABILITY_SCORE[off.availability || "in_stock"] ?? 0;
      const loyaltyScore = loyaltyPriorities[off.store?.loyaltyTier || "none"] ?? 0;
      const storeBias = storeWeights[off.store?.id || ""] ?? 0;
      const distanceScore = distanceToScore(off.store?.distanceKm);

      // lower unit price → higher score (inverse)
      const valueScore = priceToScore(unitPrice.amount);

      const score =
        valueScore * 0.60 +
        availabilityScore * 0.12 +
        loyaltyScore * 0.10 +
        storeBias * 0.10 +
        distanceScore * 0.08;

      return enrich(off, parsed, per, eff, unitPrice, score);
    });

    // Rank (stable)
    const ranked = normalized
      .sort((a, b) => b.score - a.score || a.unitPrice.amount - b.unitPrice.amount)
      .map((o, i) => ({ ...o, rank: i + 1 }));

    const result = {
      offers: ranked,
      best: ranked[0] || null,
      profileId: profile.id,
      profileLabel: profile.label,
      strategy: strategy,
    };

    eventBus.emit("pricing:compared", { count: ranked.length, best: result.best?.id || null, ts: Date.now() });
    analytics.track?.("pricing_compared", { count: ranked.length, strategy });

    return result;
  }

  // ------------------- PROFILE -------------------

  function getActiveProfile() {
    return profile;
  }

  function setActiveProfile(p) {
    profile = materializeProfile(p);
    persistProfile(profile);
    eventBus.emit("pricing:profile:activated", { profileId: profile.id, ts: Date.now() });
  }

  function exportProfile() {
    return JSON.parse(JSON.stringify(profile));
  }

  function importProfile(p) {
    const mat = materializeProfile(p);
    persistProfile(mat);
    profile = mat;
    eventBus.emit("pricing:profile:imported", { profileId: profile.id, ts: Date.now() });
    return true;
  }

  function listFavoriteProfiles() {
    return favorites.slice();
  }

  function saveFavoriteProfile(label) {
    const snap = JSON.parse(JSON.stringify(profile));
    snap.id = `pricing:fav:${Date.now()}`;
    snap.label = label || `${profile.label} ★ Favorite`;
    favorites.push(snap);
    persistFavorites(favorites);
    eventBus.emit("pricing:profile:favorited", { profileId: snap.id, ts: Date.now() });
    return snap.id;
  }

  function removeFavoriteProfile(profileId) {
    const before = favorites.length;
    favorites = favorites.filter((f) => f.id !== profileId);
    if (favorites.length !== before) {
      persistFavorites(favorites);
      eventBus.emit("pricing:profile:favorite:removed", { profileId, ts: Date.now() });
      return true;
    }
    return false;
  }

  // ------------------- CORE UTILS -------------------

  /**
   * Parse human size text into qty + uom + packCount.
   * Robust to: "2 x 12 fl oz", "3lb", "1 qt (32 fl oz)", "500 g", "4 ct", "Family Pack 3 lb".
   */
  function parseSize(sizeText = "") {
    const s = String(sizeText || "").toLowerCase().trim();
    if (!s) return { qty: 1, uom: "unit", packCount: 1, parsedFrom: "fallback", notes: ["empty size"] };

    // detect multi-pack "2 x 12 fl oz" / "2x12oz"
    const packRx = /(\d+(?:\.\d+)?)\s*[x×]\s*/i;
    let packCount = 1;
    let rest = s;
    const packM = s.match(packRx);
    if (packM) {
      packCount = Number(packM[1]);
      rest = s.replace(packRx, "");
    }

    // extract numeric qty + uom, allow parentheses hints
    // ex: "32 oz", "1 qt (32 fl oz)", "3 lb", "500 g", "12 fl oz", "4 ct"
    const partsRx = /(\d+(?:\.\d+)?)\s*(fl\s*oz|fluid\s*ounce[s]?|oz|ounce[s]?|lb|pound[s]?|g|gram[s]?|kg|kilogram[s]?|l|liter[s]?|litre[s]?|ml|milliliter[s]?|millilitre[s]?|qt|quart[s]?|ct|count|each|ea)/i;
    const m = rest.match(partsRx);
    if (!m) {
      // maybe it’s a count-based product: "6 count", "4ct"
      const cRx = /(\d+)\s*(ct|count|each|ea)\b/i;
      const c = rest.match(cRx);
      if (c) {
        return {
          qty: Number(c[1]),
          uom: "ct",
          packCount: 1,
          parsedFrom: "text",
          notes: ["count-only"],
        };
      }
      return { qty: 1, uom: "unit", packCount: 1, parsedFrom: "fallback", notes: ["unparsed"] };
    }

    let qty = Number(m[1]);
    let uom = normalizeUom(m[2]);

    // If parentheses specify a clearer sub-size (e.g., "(32 fl oz)" after "1 qt"), prefer it
    const parenRx = /\(([^)]+)\)/g;
    let match;
    let parenthetical = null;
    while ((match = parenRx.exec(rest))) {
      const pm = match[1].match(partsRx);
      if (pm) {
        parenthetical = { qty: Number(pm[1]), uom: normalizeUom(pm[2]) };
      }
    }
    if (parenthetical) {
      qty = parenthetical.qty;
      uom = parenthetical.uom;
    }

    return { qty, uom, packCount, parsedFrom: "text", notes: [] };
  }

  /**
   * Normalize to base (mass → grams; volume → mL; count → ct)
   * @param {{qty:number,uom:string,packCount:number}} dim
   * @returns {{domain:string, baseQty:number, baseUom:string, packCount:number, parsedFrom:string, notes?:string[]}}
   */
  function normalizeToBase(dim) {
    const uom = dim.uom;
    const qty = dim.qty * (dim.packCount || 1);

    if (UOM_MASS[uom]) {
      return { domain: "mass", baseQty: qty * UOM_MASS[uom], baseUom: "g", packCount: dim.packCount || 1, parsedFrom: dim.parsedFrom, notes: dim.notes };
    }
    if (UOM_VOL[uom]) {
      const ml = qty * UOM_VOL[uom];
      return { domain: "volume", baseQty: ml, baseUom: "mL", packCount: dim.packCount || 1, parsedFrom: dim.parsedFrom, notes: dim.notes };
    }
    if (UOM_COUNT[uom]) {
      return { domain: "count", baseQty: qty, baseUom: "ct", packCount: dim.packCount || 1, parsedFrom: dim.parsedFrom, notes: dim.notes };
    }
    // fallback "unit"
    return { domain: "unknown", baseQty: qty, baseUom: "unit", packCount: dim.packCount || 1, parsedFrom: dim.parsedFrom, notes: ["unknown uom"] };
  }

  /**
   * Compute unit price given effective price and normalized baseQty.
   * per choice: "100g" | "100mL" | "g" | "mL" | "ct"
   */
  function unitPriceFor(effectiveAmount, per, baseQty) {
    if (!Number.isFinite(effectiveAmount) || !Number.isFinite(baseQty) || baseQty <= 0) {
      return { amount: Infinity, per };
    }
    const scale = per === "100g" || per === "100mL" ? 100 : 1;
    return { amount: (effectiveAmount / baseQty) * scale, per };
  }

  // ------------------- INTERNALS -------------------

  function coerceToBase(offer) {
    // Prefer structured unit if present
    if (offer.unit?.qty && offer.unit?.uom) {
      const packCount = offer.unit.packCount || inferPackFromTitle(offer.title) || 1;
      const dim = { qty: offer.unit.qty, uom: normalizeUom(offer.unit.uom), packCount, parsedFrom: "unit", notes: [] };
      return normalizeToBase(dim);
    }

    // else parse sizeText, then fallback via title
    const first = parseSize(offer.sizeText || offer.title || "");
    if (first && first.qty) return normalizeToBase(first);

    // final fallback: count=1 unit
    return normalizeToBase({ qty: 1, uom: "unit", packCount: 1, parsedFrom: "fallback", notes: ["assume 1 unit"] });
  }

  function pickPer(strategy, domain, baseUnits) {
    if (strategy === "perUnit") return "ct";
    if (strategy === "per100g") return "100g";
    if (strategy === "per100mL") return "100mL";
    // auto
    if (domain === "mass")  return baseUnits.mass === "per100g" ? "100g" : "g";
    if (domain === "volume")return baseUnits.volume === "per100mL" ? "100mL" : "mL";
    if (domain === "count") return "ct";
    return "g"; // unknown: default to mass style
  }

  function computeUnitPrice(effAmount, per, baseQty) {
    return unitPriceFor(effAmount, per, baseQty);
  }

  function enrich(offer, parsed, per, effectivePrice, unitPrice, score) {
    return {
      ...offer,
      _normalized: { ...parsed },
      unitPrice,
      effectivePrice,
      score,
    };
  }

  // Effective price after prefs: tax handling, membership pseudo-adjusters, rounding
  function applyEffectivePrice(price, store, prof) {
    const cur = price?.currency || "USD";
    let amt = Number(price?.amount || 0);

    // tax handling
    const includesTax = price?.includesTax ?? false;
    const taxRate = Number(price?.taxRate || prof.defaultTaxRate || 0);
    if (!includesTax && prof.includeTaxInUnitPrice && taxRate > 0) {
      amt = amt * (1 + taxRate);
    }

    // membership weighting: if user has loyalty at this store and profile says "reflect member price"
    const tier = store?.loyaltyTier || "none";
    if (prof.reflectMemberPrice && (tier === "member" || tier === "plus")) {
      // Apply a synthetic “member benefit” if vendor feed didn’t already include it
      amt = amt * (1 - (prof.assumedMemberDiscount || 0.05)); // 5% default
    }

    // round to cents (or currency minor)
    amt = currency.toMajor(amt, cur);

    return { amount: amt, reason: buildReason(includesTax, prof, tier), currency: cur };
  }

  function buildReason(includesTax, prof, tier) {
    const bits = [];
    bits.push(includesTax || prof.includeTaxInUnitPrice ? "tax-in" : "tax-ex");
    if (prof.reflectMemberPrice && (tier === "member" || tier === "plus")) bits.push("member");
    return bits.join("+");
  }

  // ------------------- SCORING HELPERS -------------------

  function priceToScore(unitAmount) {
    if (!Number.isFinite(unitAmount) || unitAmount <= 0) return 0;
    // Convert price → value score on 0..100 (monotonic decreasing); clamp
    const score = 100 / Math.log10(10 + unitAmount); // dampens extremes
    return clamp(score, 0, 100);
  }

  function distanceToScore(km) {
    if (!Number.isFinite(km)) return 50; // neutral if unknown
    if (km <= 1) return 100;
    if (km >= 25) return 20;
    return mapRange(km, 1, 25, 100, 20);
  }

  // ------------------- MATERIALIZERS -------------------

  function hydrateActiveProfile() {
    const stored = prefs.get(PREF_KEY);
    if (stored) return materializeProfile(stored);
    const def = defaultProfile();
    persistProfile(def);
    return def;
  }

  function materializeProfile(p) {
    return {
      id: p.id || `pricing:profile:${Date.now()}`,
      label: p.label || "Household Pricing",
      strategy: p.strategy || "auto", // "auto"|"per100g"|"per100mL"|"perUnit"
      includeTaxInUnitPrice: !!p.includeTaxInUnitPrice,
      defaultTaxRate: Number(p.defaultTaxRate || 0),
      reflectMemberPrice: !!p.reflectMemberPrice,
      assumedMemberDiscount: Number.isFinite(p.assumedMemberDiscount) ? p.assumedMemberDiscount : 0.05,
      baseUnits: {
        mass: (p.baseUnits && p.baseUnits.mass) || "per100g",   // "g"|"per100g"
        volume: (p.baseUnits && p.baseUnits.volume) || "per100mL", // "mL"|"per100mL"
      },
      storeWeights: p.storeWeights || {},       // { [storeId]: -20..+20 }
      loyaltyPriorities: p.loyaltyPriorities || DEFAULT_LOYALTY_PRIORITIES,
    };
  }

  function persistProfile(p) {
    try { prefs.set(PREF_KEY, p); } catch (e) { console.warn("[PriceComparator] persistProfile", e); }
  }

  function hydrateFavorites() {
    return prefs.get(FAVORITES_KEY) || [];
  }

  function persistFavorites(arr) {
    try { prefs.set(FAVORITES_KEY, arr); } catch (e) { console.warn("[PriceComparator] persistFavorites", e); }
  }

  // ------------------- NORMALIZATION TABLES -------------------

  function normalizeUom(u) {
    const s = String(u || "").toLowerCase().replace(/\./g, "").trim();
    // common aliases
    if (s === "ounce" || s === "ounces") return "oz";
    if (s === "pound" || s === "pounds") return "lb";
    if (s === "fluid ounce" || s === "fluid ounces" || s === "fluidounce" || s === "fluidounces") return "floz";
    if (s === "fl oz" || s === "floz") return "floz";
    if (s === "liters" || s === "litres") return "l";
    if (s === "milliliters" || s === "millilitres") return "ml";
    if (s === "grams") return "g";
    if (s === "kilograms") return "kg";
    if (s === "quart" || s === "quarts") return "qt";
    if (s === "count" || s === "each" || s === "ea") return "ct";
    return s;
  }

  // mass to grams
  const UOM_MASS = {
    g: 1,
    kg: 1000,
    oz: 28.349523125,
    lb: 453.59237,
  };

  // volume to mL
  const UOM_VOL = {
    ml: 1,
    l: 1000,
    floz: 29.5735295625,
    qt: 946.352946,
  };

  const UOM_COUNT = {
    ct: 1,
    unit: 1,
  };

  const DEFAULT_BASE_UNITS = { mass: "per100g", volume: "per100mL" };

  const DEFAULT_LOYALTY_PRIORITIES = {
    none: 30,
    member: 65,
    plus: 80, // e.g., “Plus” or premium tiers
  };

  const AVAILABILITY_SCORE = {
    in_stock: 100,
    limited: 60,
    oos: 0,
  };

  // ------------------- SMALL HELPERS -------------------

  function inferPackFromTitle(title = "") {
    const m = String(title || "").toLowerCase().match(/(\d+(?:\.\d+)?)\s*[x×]\s*/i);
    return m ? Number(m[1]) : 1;
  }

  function mapRange(v, inMin, inMax, outMin, outMax) {
    const t = (v - inMin) / (inMax - inMin);
    return outMin + clamp(t, 0, 1) * (outMax - outMin);
    }
  function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

  // ------------------- SAFE ADAPTERS -------------------

  function safePrefs() {
    let mem = {};
    let ok = false;
    try { localStorage.setItem("__pc_probe", "1"); localStorage.removeItem("__pc_probe"); ok = true; } catch (_) {}
    return {
      get(k) { if (ok) { const raw = localStorage.getItem(k); return raw ? JSON.parse(raw) : null; } return mem[k] || null; },
      set(k, v) { if (ok) localStorage.setItem(k, JSON.stringify(v)); else mem[k] = v; },
    };
  }
  function safeConfig() { return { get: (_p, fb) => fb }; }
  function safeBus() { return { emit: () => {} }; }
  function safeAnalytics() { return { track: () => {} }; }
  function safeCurrency() {
    return {
      toMajor(a) { return Math.round((Number(a || 0) + Number.EPSILON) * 100) / 100; },
      format(a, c) { return `${c || "USD"} ${Number(a).toFixed(2)}`; },
    };
  }
}

// --------- Singleton convenience ---------
let __priceComparator;
export function getPriceComparatorSingleton(deps) {
  if (!__priceComparator) __priceComparator = createPriceComparator(deps);
  return __priceComparator;
}
