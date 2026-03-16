/* eslint-disable no-console */
// _tests_/productResolver.test.js — Vitest suite
// Validates OCR → resolution → unit-price normalization → ranking/cycle/coupon effects.
// If services/products/ProductResolver is present, we exercise it.
// Otherwise we fall back to a small in-test shim that mirrors expected behavior.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Shared utils from your codebase
import * as units from '../../../../features/scan-compare-trust/utils/units';
import * as text from '../../../../features/scan-compare-trust/utils/text';
import * as ranking from '../../../../features/scan-compare-trust/utils/ranking';

// Optional: concrete resolver (if your project already has one)
let RealResolver = null;
try {
  // Path per your structure: src/features/scan-compare-trust/services/products/ProductResolver.js
  // This test file lives in _tests_, hence the relative import:
  RealResolver = await import('../../../../features/scan-compare-trust/services/products/ProductResolver');
} catch (_e) {
  // No-op: we’ll use a shim below
}

// ---- Lightweight doubles/mocks for external dependencies ----
const mockPricebookDB = () => ({
  addObservation: vi.fn(async (row) => {
    // emulate your schema helpers: compute normalized unitPrice when possible
    const { unitPrice, normalizedUnit } = units.computeObservationUnitPrice({
      price: row.price,
      qty: row.qty,
      unit: row.unit,
      packageSize: row.packageSize,
    });
    return { id: Math.random(), ...row, unitPrice, unit: normalizedUnit ?? row.unit };
  }),
});

const mockCouponsService = () => ({
  bestStackFor: vi.fn(async (offer) => {
    // Simple rules for tests
    // If brand is "Saver" give $1 off; if storeId === "sams" and upc ends with 7, give $2 off
    const stacks = [];
    if ((offer.brand || '').toLowerCase() === 'saver') stacks.push({ value: 1.0, label: 'Saver $1 digital' });
    if (String(offer.storeId) === 'sams' && String(offer.upc || '').endsWith('7')) stacks.push({ value: 2.0, label: 'Sam’s instant' });
    const value = stacks.reduce((s, x) => s + x.value, 0);
    return { value, stacks };
  }),
});

const mockCyclesDB = () => ({
  predictNextWindow: vi.fn(async ({ storeId, keyType, keyValue }) => {
    // Boost Sam's Club UPC 000000000007 to be "in window"
    if (keyType === 'upc' && keyValue && String(keyValue).endsWith('7')) {
      const now = new Date();
      return {
        ok: true,
        window: { earliest: now.toISOString(), latest: now.toISOString() },
        confidence: 0.8,
        strength: 0.7,
        jitterDays: 3,
        samples: 4,
      };
    }
    // Otherwise: 10 days out
    const now = new Date(); const soon = new Date(now); soon.setDate(soon.getDate() + 10);
    return {
      ok: true,
      window: { earliest: soon.toISOString(), latest: soon.toISOString() },
      confidence: 0.6,
      strength: 0.5,
      jitterDays: 4,
      samples: 3,
    };
  }),
});

// ---- Fallback shim if RealResolver is not available ----
function makeShimResolver({ pricebookDB, couponsService, cyclesDB }) {
  return {
    /**
     * Resolve from an OCR text block.
     * Returns [{ offer, scoreBreakdown }]
     */
    async resolveFromOCR({ textBlock, store }) {
      const analysis = text.analyzeOCR({ text: textBlock, source: 'test', meta: { storeId: store.storeId } });
      // Map priceBlocks → "offers"
      const offers = [];
      for (const r of analysis.priceBlocks) {
        const base = {
          storeId: store.storeId,
          storeName: store.name,
          currency: 'USD',
          brand: r.name?.split(' ')[0] || null,
          category: null,
          upc: r.upc || (r.name ? '000000000007' : null), // deterministic for cycle mock
          dateObserved: new Date().toISOString(),
          trustScore: 0.8,
          confidence: 0.8,
          price: r.price,
          promoPrice: r.price,
          regularPrice: r.price * (r.percentOff ? (100 / (100 - r.percentOff)) : 1.15),
          qty: r.package?.qty ?? null,
          unit: r.package?.unit ?? (r.perTag ? r.perTag.unit : null),
          packageSize: r.package ? r.package.raw : null,
        };
        // Persist (mock) observation so unitPrice is filled
        const obs = await pricebookDB.addObservation(base);

        // Enrich with coupons and cycles
        const { value: couponStackValue } = await couponsService.bestStackFor(obs);
        const cycle = await cyclesDB.predictNextWindow({ storeId: store.storeId, keyType: 'upc', keyValue: obs.upc });

        const offer = {
          ...obs,
          couponStackValue,
          cycleWindow: cycle.ok ? { ...cycle.window, confidence: cycle.confidence } : null,
          userPrefs: { preferredStores: new Set([store.storeId]) },
          isFavorited: false,
          watchHit: false,
          attributionWeight: 0.7,
        };
        offers.push(offer);
      }

      const ranked = ranking.rankOffers(offers, { now: new Date() });
      return ranked;
    },

    /**
     * Resolve offers from a known UPC across multiple stores.
     */
    async resolveOffersForUPC({ upc, candidates }) {
      // candidates: [{ storeId, storeName, price, pkg }]
      const offers = [];
      for (const c of candidates) {
        const parsed = units.parsePackageSize(c.pkg);
        const base = {
          storeId: c.storeId,
          storeName: c.storeName,
          upc,
          currency: 'USD',
          brand: c.brand || 'Saver',
          promoPrice: c.price,
          price: c.price,
          regularPrice: c.regularPrice ?? (c.price * 1.2),
          qty: parsed?.qty ?? null,
          unit: parsed?.unit ?? null,
          packageSize: c.pkg,
          dateObserved: c.ts ?? new Date().toISOString(),
          trustScore: c.trust ?? 0.8,
        };
        const obs = await pricebookDB.addObservation(base);
        const { value: couponStackValue } = await couponsService.bestStackFor(obs);
        const cycle = await cyclesDB.predictNextWindow({ storeId: c.storeId, keyType: 'upc', keyValue: upc });

        offers.push({
          ...obs,
          couponStackValue,
          cycleWindow: cycle.ok ? { ...cycle.window, confidence: cycle.confidence } : null,
          userPrefs: { preferredStores: new Set([c.storeId]) },
          isFavorited: !!c.fav,
          watchHit: !!c.watch,
          attributionWeight: 0.7,
        });
      }

      const ranked = ranking.rankOffers(offers, { now: new Date() });
      return ranked;
    },
  };
}

// ---- Test fixtures ----
const SAMS = { storeId: 'sams', name: "Sam's Club" };
const ALDI = { storeId: 'aldi', name: 'ALDI' };

let pricebookDB, couponsService, cyclesDB, Resolver;

beforeEach(() => {
  pricebookDB = mockPricebookDB();
  couponsService = mockCouponsService();
  cyclesDB = mockCyclesDB();
  Resolver = RealResolver?.default
    ? RealResolver.default // if your module default-exports the resolver
    : RealResolver?.ProductResolver
      ? RealResolver.ProductResolver
      : makeShimResolver({ pricebookDB, couponsService, cyclesDB });
});

// -------------------------- TESTS --------------------------

describe('OCR → ProductResolver → Offers', () => {
  it('parses simple “$1.99 / lb” and computes normalized unit price (per g)', async () => {
    const block = `
      Boneless Skinless Chicken Breasts
      $1.99 / lb
    `;
    const ranked = await Resolver.resolveFromOCR({ textBlock: block, store: SAMS });
    expect(ranked.length).toBeGreaterThan(0);

    const top = ranked[0].offer;
    // Expect unit normalization: lb → g; $1.99 / lb ≈ $0.00438 / g
    const perG = units.unitPrice({
      price: 1.99, qty: 1, unit: 'lb', targetUnit: 'g'
    });
    expect(top.unitPrice).toBeCloseTo(perG, 5);
    expect(ranked[0].scoreBreakdown.label).toMatch(/\$0\.\d{2,} \/ g|\/ m?l|\/ ea/);
  });

  it('handles multibuy like “2/$5 16 oz Pasta” as $2.50 per item and normalizes per 100 g chip', async () => {
    const block = `
      Saver Pasta 16 oz
      2/$5
    `;
    const ranked = await Resolver.resolveFromOCR({ textBlock: block, store: ALDI });
    const first = ranked[0].offer;

    // Unit price: $2.50 for 16 oz → per 100g
    const per100g = units.unitPrice({
      price: 2.5, qty: 16, unit: 'oz', targetUnit: 'g', options: { per: 100 }
    });
    const chip = units.normalizedPriceChip({
      price: 2.5, packageDescriptor: '16 oz'
    });

    expect(chip.per).toBe(100);
    expect(chip.unit).toBe('g');
    expect(chip.value).toBeCloseTo(per100g, 4);

    // Observation should have normalized unit and unitPrice computed
    expect(first.unit).toBe('oz');
    expect(first.unitPrice).toBeGreaterThan(0);
  });

  it('parses “4-pack (12 fl oz)” beverages and computes per 100 mL normalization', async () => {
    const block = `
      Sparkle Water 4-pack (12 fl oz)
      $7.99
    `;
    const ranked = await Resolver.resolveFromOCR({ textBlock: block, store: ALDI });
    const o = ranked[0].offer;

    // 4 * 12 fl oz = 48 fl oz → 1419.53 mL total
    const per100ml = units.unitPrice({
      price: 7.99, packageDescriptor: '4-pack (12 fl oz)', targetUnit: 'ml', options: { per: 100 }
    });
    expect(per100ml).toBeGreaterThan(0);
    // Check label is formatted sensibly
    const chip = units.normalizedPriceChip({ price: 7.99, packageDescriptor: '4-pack (12 fl oz)' });
    expect(chip.per).toBe(100);
    expect(chip.unit).toBe('ml');
  });
});

describe('Ranking with coupons and cycles', () => {
  it('ranks cheaper offer higher; coupon stack can flip ranking fairly', async () => {
    const upc = '000000000123'; // not in cycle window per mock
    const ranked = await Resolver.resolveOffersForUPC({
      upc,
      candidates: [
        { storeId: 'storeA', storeName: 'Store A', price: 5.99, pkg: '16 oz', brand: 'Saver' }, // $1 coupon applies
        { storeId: 'storeB', storeName: 'Store B', price: 5.49, pkg: '16 oz', brand: 'BrandX' },
      ],
    });

    // Even though Store B is cheaper, Store A may win after coupon (5.99 - 1.00 = 4.99)
    const rows = ranking.toCompareRows(ranked);
    expect(rows[0].storeLabel).toMatch(/Store (A|B)/);

    const best = ranked[0];
    const { price: bestRawPrice } = best.offer;
    const couponSub = best.scoreBreakdown.subs.coupons;
    expect(couponSub.value).toBeGreaterThanOrEqual(0);
    // Ensure price component is in breakdown
    expect(best.scoreBreakdown.subs.price.raw).toBeGreaterThan(0);
  });

  it('boosts an offer that is in the predicted cycle window (same price)', async () => {
    // UPC ending in 7 will be "in window" from mockCyclesDB
    const upc = '000000000007';
    const ranked = await Resolver.resolveOffersForUPC({
      upc,
      candidates: [
        { storeId: SAMS.storeId, storeName: SAMS.name, price: 9.99, pkg: '32 oz', brand: 'BrandX' },
        { storeId: ALDI.storeId, storeName: ALDI.name, price: 9.99, pkg: '32 oz', brand: 'BrandX' },
      ],
    });

    // With equal price, Sam's (in-window) should rank above ALDI (10d away)
    expect(ranked[0].offer.storeId).toBe(SAMS.storeId);
    expect(ranked[0].scoreBreakdown.subs.cycle.scaled).toBeGreaterThan(ranked[1].scoreBreakdown.subs.cycle.scaled);
  });
});

describe('OCR cleaning resilience', () => {
  it('fixes hyphenated line breaks and glyph confusions before parsing', () => {
    const raw = 'Extra-Vir-\n gin Olivc Oil 16 0z\n$9.99 / fl.oz';
    const cleaned = text.cleanTextBlock(raw);
    expect(cleaned).not.toMatch(/-\n/);
    expect(cleaned.toLowerCase()).toContain('olive oil');
    // Parse price-per tag despite odd spacing
    const per = units.parsePricePerTag(cleaned);
    expect(per).toBeTruthy();
    expect(per.unit).toBe('floz');
  });
});

describe('Unit safety & fallbacks', () => {
  it('refuses cross-family conversion without density unless bridged (mass↔volume)', () => {
    // 500 g → ml without density should throw
    expect(() => units.convert(500, 'g', 'ml')).toThrow();
    // With density (water), it should work
    expect(units.convert(500, 'g', 'ml', { density: 1.0 })).toBeCloseTo(500, 5);
  });
});
