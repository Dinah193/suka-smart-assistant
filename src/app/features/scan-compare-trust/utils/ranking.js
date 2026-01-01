/* eslint-disable no-console */
// utils/ranking.js — scoring helpers (price, trust) for Scan • Compare • Trust
// Style: dependency-light, explainable scoring, safe fallbacks.
// Integrates with: units.js, pricebook schema, coupons.schema, cycles.schema, user_prefs, favorites.

import {
  unitPrice,
  normalizeUnit,
  defaultTargetUnitFor,
  formatUnitPrice,
} from './units';

/**
 * Default weights (tuned to feel “fair” in grocery comparisons).
 * You can override per call via options.weights.
 */
export const DEFAULT_WEIGHTS = {
  price: 0.42,          // normalized unit price competitiveness
  recency: 0.10,        // freshness of observation
  trust: 0.15,          // observation/source confidence
  cycle: 0.12,          // near predicted sale window
  coupons: 0.14,        // stack value uplift
  safety: -0.10,        // ingredient alerts/recalls penalty
  affinity: 0.17,       // user brand/store affinity & favorites/watchlists boost
};

/**
 * Score a single “offer” row.
 * Expected shape (lightweight DTO; extra fields are ignored):
 * {
 *   price, regularPrice, promoPrice,
 *   qty, unit, packageSize, currency,
 *   storeId, storeName, chain,
 *   upc, brand, category,
 *   dateObserved, trustScore, confidence,
 *   // Optional enrichments to avoid extra lookups:
 *   couponStackValue,        // numeric savings from chosen stack (per item basis)
 *   cycleWindow: { earliest, latest, confidence }, // from cyclesDB.predictNextWindow
 *   ingredientFlags: [{ alertType, severity }],    // from ingredient_alerts
 *   userPrefs: { preferredStores:Set, avoidedStores:Set, preferredBrands:Set, avoidedBrands:Set },
 *   isFavorited: boolean,    // user favorited this session/offer
 *   watchHit: boolean,       // watchlist says 'soon/open/close/overdue'
 *   attributionWeight: number // aggregate weight from source_attributions (0..1)
 * }
 *
 * @param {Object} offer
 * @param {Object} ctx {
 *    comparators: [{unitPrice:number, storeId, label}], // peer offers for the same item
 *    targetUnit?: string, // force target normalization unit; otherwise inferred
 *    now?: Date,
 *    weights?: Partial<typeof DEFAULT_WEIGHTS>,
 *    recencyHalfLifeDays?: number, // default 21 days
 *    safetyPenaltyPerSeverity?: number, // default 0.12
 *    affinityBoosts?: { favorite: number, watchHit: number, preferredStore: number, preferredBrand: number, avoidedStore: number, avoidedBrand: number }
 * }
 * @returns { score:number, subs:{...}, unitPrice:number, targetUnit:string, label:string }
 */
export function scoreOffer(offer = {}, ctx = {}) {
  const now = ctx.now || new Date();
  const weights = { ...DEFAULT_WEIGHTS, ...(ctx.weights || {}) };

  // ---------- 1) Unit Price (normalized) ----------
  const inferredUnit = normalizeUnit(offer.unit) || inferUnitFromPackage(offer.packageSize);
  const targetUnit = ctx.targetUnit || defaultTargetUnitFor(inferredUnit || 'ea');

  const uPrice = unitPrice({
    price: bestPrice(offer),
    qty: offer.qty ?? null,
    unit: inferredUnit,
    packageDescriptor: offer.packageSize || null,
    targetUnit,
    options: {},
  });

  // If we cannot compute unit price, treat as neutral (will get low price score).
  const normalizedPrice = Number.isFinite(uPrice) ? uPrice : null;

  // Price competitiveness among comparators (min-max to 0..1; lower is better).
  const priceSub = (() => {
    const peers = (ctx.comparators || [])
      .map(x => x?.unitPrice)
      .filter(x => Number.isFinite(x));
    if (Number.isFinite(normalizedPrice)) peers.push(normalizedPrice);
    if (peers.length < 2 || !Number.isFinite(normalizedPrice)) {
      return { raw: normalizedPrice, scaled: 0.5, peers: peers.length };
    }
    const min = Math.min(...peers);
    const max = Math.max(...peers);
    const span = Math.max(1e-6, max - min);
    const relative = (normalizedPrice - min) / span; // 0 = best, 1 = worst
    // Map so cheaper → higher subscore (1..0)
    const scaled = 1 - clamp01(relative);
    return { raw: normalizedPrice, scaled, peers: peers.length, min, max };
  })();

  // ---------- 2) Recency (freshness) ----------
  const recencySub = (() => {
    const ts = new Date(offer.dateObserved || offer.updatedAt || offer.weekOf || 0).getTime();
    if (!ts) return { scaled: 0.5, ageDays: null };
    const ageDays = Math.max(0, (now.getTime() - ts) / (1000 * 60 * 60 * 24));
    // Half-life decay (21d by default): 1 * 0.5^(age/halfLife)
    const halfLife = ctx.recencyHalfLifeDays || 21;
    const scaled = Math.pow(0.5, ageDays / halfLife);
    return { scaled, ageDays };
  })();

  // ---------- 3) Trust (source quality + attribution) ----------
  const trustBase = clamp01(offer.trustScore ?? offer.confidence ?? 0.5);
  const attribution = clamp01(offer.attributionWeight ?? 0.6);
  // Blend: prioritize trustBase but allow attribution to sway ±20%
  const trustScaled = clamp01(trustBase * 0.8 + attribution * 0.2);

  // ---------- 4) Cycle proximity (sale likely soon/now) ----------
  const cycleSub = (() => {
    const cw = offer.cycleWindow;
    if (!cw?.earliest) return { scaled: 0 };
    const earliest = new Date(cw.earliest);
    const latest = cw.latest ? new Date(cw.latest) : earliest;
    const distDays = daysToWindow(now, earliest, latest); // 0 in window, >0 outside
    // Shape: in-window → 1.0; within 7d → 0.8..1; 30d out → ~0.2; else 0
    let base;
    if (distDays <= 0) base = 1.0;
    else if (distDays <= 7) base = 0.8 + (7 - distDays) * 0.03;  // 0.8..1.0
    else if (distDays <= 30) base = 0.2 + (30 - distDays) * (0.6/23); // ~0.2..0.8
    else base = 0.05;
    const conf = clamp01(cw.confidence ?? 0.6);
    return { scaled: clamp01(base * (0.7 + 0.3 * conf)), distDays, conf };
  })();

  // ---------- 5) Coupon stack (uplift) ----------
  const couponsSub = (() => {
    const v = Number(offer.couponStackValue ?? 0); // per-item absolute reduction
    // Convert absolute reduction into a dimensionless uplift: reduction / price, capped
    const basePrice = bestPrice(offer);
    if (!Number.isFinite(v) || !Number.isFinite(basePrice) || basePrice <= 0) {
      return { scaled: 0, value: 0 };
    }
    const ratio = clamp01(v / basePrice); // 0..1
    // Gentle non-linear boost (diminishing returns)
    const scaled = clamp01(Math.sqrt(ratio)); // 0..1
    return { scaled, value: v, ratio };
  })();

  // ---------- 6) Ingredient safety / recalls (penalty) ----------
  const safetySub = (() => {
    const flags = Array.isArray(offer.ingredientFlags) ? offer.ingredientFlags : [];
    if (!flags.length) return { scaled: 1, penalty: 0, count: 0 };
    const perSeverity = ctx.safetyPenaltyPerSeverity ?? 0.12;
    const totalSeverity = flags.reduce((s, f) => s + Number(f.severity ?? 1), 0);
    const penalty = clamp01(totalSeverity * perSeverity); // 0..1
    // Apply as multiplicative factor (1-penalty)
    const scaled = clamp01(1 - penalty);
    return { scaled, penalty, count: flags.length };
  })();

  // ---------- 7) User affinity (prefs, favorites, watch hits) ----------
  const affinitySub = (() => {
    const prefs = offer.userPrefs || {};
    const boosts = {
      favorite: 0.10,
      watchHit: 0.08,
      preferredStore: 0.06,
      preferredBrand: 0.05,
      avoidedStore: -0.15,
      avoidedBrand: -0.10,
      ...(ctx.affinityBoosts || {}),
    };

    let score = 0;
    // Favorites/watchlists
    if (offer.isFavorited) score += boosts.favorite;
    if (offer.watchHit) score += boosts.watchHit;

    // Store affinity
    const ps = prefs.preferredStores instanceof Set ? prefs.preferredStores : new Set(prefs.preferredStores || []);
    const as = prefs.avoidedStores   instanceof Set ? prefs.avoidedStores   : new Set(prefs.avoidedStores   || []);
    if (offer.storeId && ps.has(offer.storeId)) score += boosts.preferredStore;
    if (offer.storeId && as.has(offer.storeId)) score += boosts.avoidedStore;

    // Brand affinity
    const pb = prefs.preferredBrands instanceof Set ? prefs.preferredBrands : new Set(prefs.preferredBrands || []);
    const ab = prefs.avoidedBrands   instanceof Set ? prefs.avoidedBrands   : new Set(prefs.avoidedBrands   || []);
    if (offer.brand && pb.has(String(offer.brand).toLowerCase())) score += boosts.preferredBrand;
    if (offer.brand && ab.has(String(offer.brand).toLowerCase())) score += boosts.avoidedBrand;

    // Clamp into [0,1] after mapping into a 0..1 uplift around a 0 baseline
    return { scaled: clamp01(0.5 + score), raw: score };
  })();

  // ---------- Composite ----------
  // Components mostly in [0..1]; safetySub is multiplicative; affinity centered at 0.5 baseline.
  const composite =
      weights.price   * (priceSub.scaled ?? 0.5) +
      weights.recency * (recencySub.scaled ?? 0.5) +
      weights.trust   * (trustScaled ?? 0.5) +
      weights.cycle   * (cycleSub.scaled ?? 0) +
      weights.coupons * (couponsSub.scaled ?? 0) +
      weights.affinity* (affinitySub.scaled ?? 0.5);

  // Safety multiplier (downweight after summing), then clamp
  const score = clamp01(composite * (safetySub.scaled ?? 1));

  return {
    score,
    unitPrice: normalizedPrice,
    targetUnit,
    label: Number.isFinite(normalizedPrice)
      ? formatUnitPrice(normalizedPrice, targetUnit, { per: 1, currency: offer.currency || 'USD' })
      : '—',
    subs: {
      price: priceSub,
      recency: recencySub,
      trust: { base: trustBase, attribution, scaled: trustScaled },
      cycle: cycleSub,
      coupons: couponsSub,
      safety: safetySub,
      affinity: affinitySub,
      weights,
    }
  };
}

/**
 * Rank a set of offers for a single product/UPC (or a compare-card list).
 * @param {Array<Object>} offers
 * @param {Object} ctx same as scoreOffer ctx
 * @returns {Array<{offer, scoreBreakdown}>} sorted high→low
 */
export function rankOffers(offers = [], ctx = {}) {
  // Precompute peer unit prices for relative price scaling
  const targetUnit = ctx.targetUnit || chooseCommonTargetUnit(offers);
  const comparators = offers
    .map(o => ({
      unitPrice: unitPrice({
        price: bestPrice(o),
        qty: o.qty ?? null,
        unit: normalizeUnit(o.unit) || inferUnitFromPackage(o.packageSize),
        packageDescriptor: o.packageSize || null,
        targetUnit,
        options: {},
      }),
      storeId: o.storeId,
      label: o.storeName || o.chain || '',
    }));

  const enriched = offers.map((o, idx) => {
    const breakdown = scoreOffer(o, { ...ctx, targetUnit, comparators });
    return { offer: o, scoreBreakdown: breakdown, idx };
  });

  enriched.sort((a, b) => (b.scoreBreakdown.score - a.scoreBreakdown.score));
  return enriched;
}

/* --------------------------------- Helpers --------------------------------- */

function bestPrice(o) {
  if (Number.isFinite(o.promoPrice)) return Number(o.promoPrice);
  if (Number.isFinite(o.price)) return Number(o.price);
  if (Number.isFinite(o.regularPrice)) return Number(o.regularPrice);
  return null;
}

function chooseCommonTargetUnit(offers = []) {
  // Pick a sensible normalization based on the first known unit we can parse
  for (const o of offers) {
    const u = normalizeUnit(o.unit) || inferUnitFromPackage(o.packageSize);
    if (u) return defaultTargetUnitFor(u);
  }
  return 'ea';
}

function inferUnitFromPackage(pkg) {
  if (!pkg || typeof pkg !== 'string') return null;
  // try to read something like "16 oz" | "12 ct" | "2x16oz"
  const m = pkg.toLowerCase().match(/(?:\d+(?:\.\d+)?)\s*([a-z. ]+)/) || pkg.toLowerCase().match(/[a-z.]+$/);
  if (!m) return null;
  return normalizeUnit(m[1]);
}

function daysToWindow(now, earliest, latest) {
  const dNow = startOfDay(now);
  const dEar = startOfDay(earliest);
  const dLat = startOfDay(latest);
  if (dNow >= dEar && dNow <= dLat) return 0;       // inside window
  if (dNow < dEar) return Math.round((dEar - dNow) / ONE_DAY);
  return Math.round((dNow - dLat) / ONE_DAY);       // days past end
}

const ONE_DAY = 24 * 60 * 60 * 1000;
function startOfDay(d) { const x = new Date(d); x.setHours(0,0,0,0); return x; }
function clamp01(n) { return Math.max(0, Math.min(1, Number(n) || 0)); }

/* --------------------------- Tiny convenience API --------------------------- */

/**
 * Convenience to return a UI-friendly model for a compare table:
 * [{storeLabel, priceLabel, score, reasons[]}]
 */
export function toCompareRows(ranked = []) {
  return ranked.map(({ offer, scoreBreakdown }) => {
    const reasons = [];

    // Price reason
    if (scoreBreakdown.subs?.price?.raw != null) {
      const p = scoreBreakdown.subs.price;
      if (p.min != null && p.max != null) {
        if (p.raw <= p.min + (p.max - p.min) * 0.1) reasons.push('lowest price');
        else if (p.raw <= p.min + (p.max - p.min) * 0.2) reasons.push('among lowest');
      } else {
        reasons.push('good price');
      }
    }

    // Recency
    if ((scoreBreakdown.subs?.recency?.ageDays ?? 999) <= 7) reasons.push('fresh data');

    // Coupons
    if ((scoreBreakdown.subs?.coupons?.value ?? 0) > 0) reasons.push('coupon savings applied');

    // Cycle
    if (scoreBreakdown.subs?.cycle?.distDays === 0) reasons.push('in sale window');

    // Safety
    if ((scoreBreakdown.subs?.safety?.count ?? 0) > 0) reasons.push('safety alerts present');

    // Affinity
    const aff = scoreBreakdown.subs?.affinity?.raw ?? 0;
    if (aff > 0.08) reasons.push('matches your preferences');

    return {
      storeLabel: offer.storeName || offer.chain || `Store #${offer.storeId || ''}`,
      priceLabel: scoreBreakdown.label,
      score: scoreBreakdown.score,
      reasons,
      targetUnit: scoreBreakdown.targetUnit,
    };
  });
}

export default {
  DEFAULT_WEIGHTS,
  scoreOffer,
  rankOffers,
  toCompareRows,
};
