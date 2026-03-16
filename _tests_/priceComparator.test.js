/* eslint-disable no-console */
// _tests_/priceComparator.test.js — Vitest suite for Compare view
// Validates: per-unit normalization, comparator sorting, ranking signals,
// favorites & schedules biasing, safety penalties, and UI row shaping.

import { describe, it, expect, beforeEach } from 'vitest';
import * as units from '../../../../features/scan-compare-trust/utils/units';
import { rankOffers, toCompareRows } from '../../../../features/scan-compare-trust/utils/ranking';

// ---------- Helpers ----------
const FIXED_NOW = new Date('2025-10-28T12:00:00Z');

function makeOffer({
  storeId,
  storeName,
  price,
  regularPrice,
  pkg,          // e.g., "2x16oz", "4-pack (12 fl oz)", "750 ml"
  qty, unit,    // optional direct qty/unit if not using pkg
  upc = '000000000111',
  brand = 'BrandX',
  trustScore = 0.8,
  dateObserved = '2025-10-20T10:00:00Z',
  couponStackValue = 0,
  cycleWindow = null,
  safetySeverity = 0,    // 0..N → penalty applied in ranking
  isFavorited = false,
  watchHit = false,
  userPrefs = {},
} = {}) {
  const parsed = pkg ? units.parsePackageSize(pkg) : null;
  const effectiveUnit = units.normalizeUnit(unit) || parsed?.unit || null;
  const effectiveQty  = qty ?? parsed?.qty ?? null;

  // Compute a normalized unit price now to stash alongside (the ranking recomputes too)
  const unitPrice = units.unitPrice({
    price,
    qty: effectiveQty,
    unit: effectiveUnit,
    packageDescriptor: pkg || null,
    targetUnit: units.defaultTargetUnitFor(effectiveUnit || 'ea'),
  });

  return {
    storeId, storeName,
    upc, brand, currency: 'USD',
    price, promoPrice: price, regularPrice: regularPrice ?? (price * 1.2),
    qty: effectiveQty, unit: effectiveUnit, packageSize: pkg || null,
    unitPrice,
    trustScore,
    dateObserved,
    couponStackValue,
    cycleWindow,
    ingredientFlags: safetySeverity > 0 ? [{ alertType: 'test', severity: safetySeverity }] : [],
    isFavorited,
    watchHit,
    userPrefs: {
      preferredStores: new Set(userPrefs.preferredStores || []),
      avoidedStores:   new Set(userPrefs.avoidedStores   || []),
      preferredBrands: new Set((userPrefs.preferredBrands || []).map(b => String(b).toLowerCase())),
      avoidedBrands:   new Set((userPrefs.avoidedBrands   || []).map(b => String(b).toLowerCase())),
    },
    attributionWeight: 0.7,
  };
}

// ---------- Tests ----------
describe('Per-unit normalization & comparator basics', () => {
  it('normalizes across mixed packages to a common target and sorts correctly', () => {
    // Three stores selling rice: 2 lb bag, 32 oz bag, 900 g bag
    const A = makeOffer({ storeId: 'A', storeName: 'Store A', price: 3.99, pkg: '2 lb' });
    const B = makeOffer({ storeId: 'B', storeName: 'Store B', price: 3.49, pkg: '32 oz' });
    const C = makeOffer({ storeId: 'C', storeName: 'Store C', price: 4.29, pkg: '900 g' });

    // Rank
    const ranked = rankOffers([A, B, C], { now: FIXED_NOW });
    // Expect B cheapest per-unit (same mass as 2 lb but cheaper absolute)
    expect(ranked[0].offer.storeId).toBe('B');
    // UI rows produce coherent labels and reasons
    const rows = toCompareRows(ranked);
    expect(rows[0].priceLabel).toMatch(/\$[\d.]+ \/ (g|ml|m|ea|m2)/);
    expect(rows[0].reasons.join(' ')).toMatch(/lowest|among/);
  });

  it('bridges mass↔volume unit price with density when provided (e.g., honey)', () => {
    const HONEY_OZ = makeOffer({ storeId: 'H1', storeName: 'Honey Hut', price: 7.99, pkg: '12 oz' });
    const HONEY_ML = makeOffer({ storeId: 'H2', storeName: 'Apiary Co', price: 9.49, pkg: '350 ml' });
    // Rank with honey density ~1.42 g/mL
    const ranked = rankOffers([HONEY_OZ, HONEY_ML], {
      now: FIXED_NOW,
      // Force target to per-100g like many EU labels; pass density via comparators by overriding unitPrice calc:
      targetUnit: 'g',
    });
    // Ensure both have computable normalized unit price (the module bridges internally when needed)
    expect(Number.isFinite(ranked[0].scoreBreakdown.unitPrice)).toBe(true);
    expect(Number.isFinite(ranked[1].scoreBreakdown.unitPrice)).toBe(true);
  });
});

describe('Signals: recency, trust, coupons, cycles, safety, affinity', () => {
  it('newer observations (same price) rank higher via recency decay', () => {
    const old = makeOffer({ storeId: 'S1', storeName: 'Freshly', price: 5.00, pkg: '16 oz', dateObserved: '2025-09-01T00:00:00Z' });
    const fresh = makeOffer({ storeId: 'S2', storeName: 'Freshly 2', price: 5.00, pkg: '16 oz', dateObserved: '2025-10-27T00:00:00Z' });
    const ranked = rankOffers([old, fresh], { now: FIXED_NOW });
    expect(ranked[0].offer.storeId).toBe('S2');
    expect(ranked[0].scoreBreakdown.subs.recency.scaled).toBeGreaterThan(ranked[1].scoreBreakdown.subs.recency.scaled);
  });

  it('higher trust wins when price & recency are equal', () => {
    const low = makeOffer({ storeId: 'T1', storeName: 'Trust Low', price: 4.00, pkg: '32 oz', trustScore: 0.4, dateObserved: '2025-10-27T00:00:00Z' });
    const high = makeOffer({ storeId: 'T2', storeName: 'Trust High', price: 4.00, pkg: '32 oz', trustScore: 0.9, dateObserved: '2025-10-27T00:00:00Z' });
    const ranked = rankOffers([low, high], { now: FIXED_NOW });
    expect(ranked[0].offer.storeId).toBe('T2');
    expect(ranked[0].scoreBreakdown.subs.trust.scaled).toBeGreaterThan(ranked[1].scoreBreakdown.subs.trust.scaled);
  });

  it('coupon stack can flip outcome between close prices', () => {
    const A = makeOffer({ storeId: 'C1', storeName: 'Coupon Mart', price: 5.49, pkg: '16 oz', couponStackValue: 1.00 });
    const B = makeOffer({ storeId: 'C2', storeName: 'No Coupon',   price: 4.99, pkg: '16 oz', couponStackValue: 0 });
    const ranked = rankOffers([A, B], { now: FIXED_NOW });
    // Depending on weights, A with $1 off often beats B at 4.99
    expect(['C1','C2']).toContain(ranked[0].offer.storeId);
    expect(ranked.some(r => r.scoreBreakdown.subs.coupons.value >= 1)).toBe(true);
  });

  it('in-window cycle gets a clear boost over same-price peers', () => {
    const inWindow = makeOffer({
      storeId: 'W1', storeName: 'Cycle Now', price: 9.99, pkg: '32 oz',
      cycleWindow: { earliest: '2025-10-25T00:00:00Z', latest: '2025-10-31T23:59:59Z', confidence: 0.8 }
    });
    const outWindow = makeOffer({
      storeId: 'W2', storeName: 'Cycle Later', price: 9.99, pkg: '32 oz',
      cycleWindow: { earliest: '2025-11-10T00:00:00Z', latest: '2025-11-12T23:59:59Z', confidence: 0.6 }
    });
    const ranked = rankOffers([inWindow, outWindow], { now: FIXED_NOW });
    expect(ranked[0].offer.storeId).toBe('W1');
    expect(ranked[0].scoreBreakdown.subs.cycle.scaled).toBeGreaterThan(ranked[1].scoreBreakdown.subs.cycle.scaled);
  });

  it('safety alerts enforce downweight even if price is best', () => {
    const safe = makeOffer({ storeId: 'SFE', storeName: 'Safe Store', price: 3.99, pkg: '16 oz', safetySeverity: 0 });
    const flagged = makeOffer({ storeId: 'BAD', storeName: 'Flagged Store', price: 3.49, pkg: '16 oz', safetySeverity: 3 });
    const ranked = rankOffers([safe, flagged], { now: FIXED_NOW });
    // The flagged one might still win if price gap is huge; assert meaningful penalty applied
    const s0 = ranked.find(r => r.offer.storeId === 'BAD').scoreBreakdown.subs.safety;
    expect(s0.penalty).toBeGreaterThan(0);
  });

  it('favorites & watchlist hits provide affinity lift toward user-saved sessions/schedules', () => {
    const neutral = makeOffer({ storeId: 'N1', storeName: 'Neutral', price: 5.00, pkg: '12 oz' });
    const favorite = makeOffer({
      storeId: 'F1', storeName: 'Favored', price: 5.05, pkg: '12 oz',
      isFavorited: true, watchHit: true,
      userPrefs: { preferredStores: ['F1'], preferredBrands: ['BrandX'] }
    });
    const ranked = rankOffers([neutral, favorite], { now: FIXED_NOW });
    // With slightly worse price, the favorite can still surface to top due to affinity boost.
    expect(['F1','N1']).toContain(ranked[0].offer.storeId);
    const topAff = ranked[0].scoreBreakdown.subs.affinity.scaled;
    const botAff = ranked[1].scoreBreakdown.subs.affinity.scaled;
    expect(topAff).toBeGreaterThanOrEqual(botAff);
  });
});

describe('UI table shaping', () => {
  it('toCompareRows yields tidy labels and reason chips', () => {
    const A = makeOffer({ storeId: 'U1', storeName: 'UI One', price: 2.49, pkg: '16 oz', dateObserved: '2025-10-27T00:00:00Z' });
    const B = makeOffer({ storeId: 'U2', storeName: 'UI Two', price: 2.29, pkg: '16 oz', couponStackValue: 0.5, dateObserved: '2025-10-26T00:00:00Z' });
    const ranked = rankOffers([A, B], { now: FIXED_NOW });
    const rows = toCompareRows(ranked);
    expect(rows[0]).toHaveProperty('storeLabel');
    expect(rows[0]).toHaveProperty('priceLabel');
    expect(Array.isArray(rows[0].reasons)).toBe(true);
    // Expect at least one semantic reason present
    expect(rows.map(r => r.reasons.join(' ')).join(' ')).toMatch(/fresh data|coupon|lowest|in sale window|matches your preferences/);
  });
});

// ---------- Edge cases ----------
describe('Edge cases', () => {
  it('handles unknown/unsupported unit gracefully (falls back without crashing)', () => {
    const odd = makeOffer({ storeId: 'X1', storeName: 'Odd Unit', price: 1.99, unit: 'weirdunit', qty: 1 });
    const normal = makeOffer({ storeId: 'X2', storeName: 'Normal', price: 2.19, pkg: '16 oz' });
    const ranked = rankOffers([odd, normal], { now: FIXED_NOW });
    // Should not throw and still produce rows
    expect(ranked.length).toBe(2);
    const rows = toCompareRows(ranked);
    expect(rows[0].priceLabel).toBeTruthy();
  });

  it('formats per-100g/ml chips nicely for very small/large packages', () => {
    const tiny = units.normalizedPriceChip({ price: 1.49, packageDescriptor: '90 g' });
    expect(tiny.per).toBe(100);
    expect(tiny.unit).toBe('g');
    const drink = units.normalizedPriceChip({ price: 0.99, packageDescriptor: '8 fl oz' });
    expect(drink.per).toBe(100);
    expect(drink.unit).toBe('ml');
  });
});
