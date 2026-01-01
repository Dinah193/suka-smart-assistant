// C:\Users\larho\suka-smart-assistant\src\tests\calculators\gardenAnimal\ButcheryWeightCalculator.test.js
// -----------------------------------------------------------------------------
// Unit tests for ButcheryWeightCalculator: live weight → carcass → retail
// yields for homestead animals.
//
// ASSUMED PUBLIC API
// -----------------------------------------------------------------------------
//
//   import { calculateButcheryWeights } from
//     "@/features/calculators/gardenAnimal/ButcheryWeightCalculator.logic.js";
//
//   const result = calculateButcheryWeights(config);
//
// Where `config` roughly looks like:
//
//   {
//     species: "cow" | "beef" | "lamb" | "goat" | "pig" | "chicken" | string,
//     liveWeightLb: number, // per-head live weight in lb
//     count?: number,       // default 1
//     options?: {
//       // Percentages are 0–100; if omitted, species defaults apply:
//       // e.g. beef: dressing 62, shrink 3, cutout 72, etc.
//       dressingPct?: number, // live → hanging/dressed
//       shrinkPct?: number,   // hanging → post-chill shrink
//       cutoutPct?: number,   // hanging → boneless retail (before trim losses)
//       bonePct?: number,     // of carcass or of hanging, depending on implementation
//       offalPct?: number,
//       trimPct?: number,     // further trim loss from cutout
//       units?: "lb" | "kg"   // output unit for weights, default "lb"
//     }
//   }
//
// and the calculator returns something like:
//
//   {
//     species: string,
//     count: number,
//     params: {
//       dressingPct: number,
//       shrinkPct: number,
//       cutoutPct: number,
//       bonePct: number,
//       offalPct: number,
//       trimPct: number,
//       units: "lb" | "kg"
//     },
//     weights: {
//       liveWeightPerHead: number,
//       liveWeightTotal: number,
//       dressedPerHead: number,
//       dressedTotal: number,
//       hangingPerHead: number,
//       hangingTotal: number,
//       cutoutPerHead: number,
//       cutoutTotal: number,
//       retailPerHead: number,
//       retailTotal: number,
//       bonePerHead: number,
//       boneTotal: number,
//       offalPerHead: number,
//       offalTotal: number,
//       trimLossPerHead: number,
//       trimLossTotal: number,
//       totalLossPerHead: number,
//       totalLossTotal: number
//     },
//     primals?: {
//       // optional per-primal breakdown, e.g.:
//       // ribeye: { weight: number, pctOfCarcass: number }, ...
//     },
//     warnings?: string[]  // e.g. "Percentages clamped to 0–100", etc.
//   }
//
// These tests focus on:
//   * Shape validation & absence of NaNs
//   * Reasonable numeric behavior & relationships between fields
//   * Known %-based scenario for beef (close to expected values)
//   * Species defaults (e.g. lamb vs beef yield patterns)
//   * Unit conversion behavior ("lb" vs "kg")
//   * Defensive handling of invalid inputs
//   * Stable ranges suitable for SSA Planning Graph & SessionRunner
// -----------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import { calculateButcheryWeights } from "@/features/calculators/gardenAnimal/ButcheryWeightCalculator.logic.js";

// -----------------------------------------------------------------------------
// Helper assertions
// -----------------------------------------------------------------------------

function assertFiniteNumber(value) {
  expect(typeof value).toBe("number");
  expect(Number.isFinite(value)).toBe(true);
}

function assertNonNegativeFinite(value) {
  assertFiniteNumber(value);
  expect(value).toBeGreaterThanOrEqual(0);
}

function assertWeightsShape(result) {
  expect(result).toBeTruthy();
  expect(typeof result).toBe("object");

  expect(typeof result.species).toBe("string");
  expect(typeof result.count).toBe("number");

  expect(result.params).toBeTruthy();
  expect(typeof result.params).toBe("object");
  const p = result.params;

  ["dressingPct", "shrinkPct", "cutoutPct", "bonePct", "offalPct", "trimPct"].forEach(
    (key) => {
      assertFiniteNumber(p[key]);
      expect(p[key]).toBeGreaterThanOrEqual(0);
      expect(p[key]).toBeLessThanOrEqual(100);
    }
  );
  expect(["lb", "kg"]).toContain(p.units);

  expect(result.weights).toBeTruthy();
  const w = result.weights;

  [
    "liveWeightPerHead",
    "liveWeightTotal",
    "dressedPerHead",
    "dressedTotal",
    "hangingPerHead",
    "hangingTotal",
    "cutoutPerHead",
    "cutoutTotal",
    "retailPerHead",
    "retailTotal",
    "bonePerHead",
    "boneTotal",
    "offalPerHead",
    "offalTotal",
    "trimLossPerHead",
    "trimLossTotal",
    "totalLossPerHead",
    "totalLossTotal"
  ].forEach((key) => {
    assertNonNegativeFinite(w[key]);
  });

  // Totals should be ~= per-head * count (allowing tiny FP drift)
  const c = result.count || 1;
  const keys = [
    "liveWeight",
    "dressed",
    "hanging",
    "cutout",
    "retail",
    "bone",
    "offal",
    "trimLoss",
    "totalLoss"
  ];

  keys.forEach((base) => {
    const perHead = w[`${base}PerHead`];
    const total = w[`${base}Total`];

    if (perHead === 0 && total === 0) return;
    const expectedTotal = perHead * c;
    const diff = Math.abs(expectedTotal - total);
    expect(diff).toBeLessThan(expectedTotal * 0.01 + 1e-6); // within ~1%
  });

  if (result.warnings) {
    expect(Array.isArray(result.warnings)).toBe(true);
  }
}

// -----------------------------------------------------------------------------
// 1) Basic beef scenario – known %-based behavior
// -----------------------------------------------------------------------------

describe("ButcheryWeightCalculator – basic beef 1200 lb live", () => {
  it("matches expected dressing, shrink, and cutout relationships", () => {
    // A fairly standard US beef scenario for sanity-check:
    //  - 1200 lb live
    //  - 62% dressing → 744 lb dressed/hanging
    //  - 3% shrink → ~721.7 lb post-chill
    //  - 72% cutout of hanging → ~519.6 lb boneless/retail
    const liveWeightLb = 1200;
    const dressingPct = 62;
    const shrinkPct = 3;
    const cutoutPct = 72;

    const result = calculateButcheryWeights({
      species: "beef",
      liveWeightLb,
      count: 1,
      options: {
        dressingPct,
        shrinkPct,
        cutoutPct,
        bonePct: 18,
        offalPct: 10,
        trimPct: 4,
        units: "lb"
      }
    });

    assertWeightsShape(result);

    const w = result.weights;

    // Live weight per head should match input.
    expect(w.liveWeightPerHead).toBeCloseTo(liveWeightLb, 6);

    // Dressed weight ≈ live * dressing%
    const expectedDressed = liveWeightLb * (dressingPct / 100);
    expect(w.dressedPerHead).toBeCloseTo(expectedDressed, 1);

    // Hanging includes shrink
    const expectedHanging =
      expectedDressed * (1 - shrinkPct / 100);
    expect(w.hangingPerHead).toBeCloseTo(expectedHanging, 1);

    // Cutout based on hanging
    const expectedCutout = expectedHanging * (cutoutPct / 100);
    expect(w.cutoutPerHead).toBeCloseTo(expectedCutout, 1);

    // Retail should be less than or equal to cutout due to trimLoss
    expect(w.retailPerHead).toBeGreaterThan(0);
    expect(w.retailPerHead).toBeLessThanOrEqual(w.cutoutPerHead);

    // Total losses should be less than live weight
    expect(w.totalLossPerHead).toBeGreaterThan(0);
    expect(w.totalLossPerHead).toBeLessThan(w.liveWeightPerHead);
  });
});

// -----------------------------------------------------------------------------
// 2) Species defaults – lamb vs beef
// -----------------------------------------------------------------------------

describe("ButcheryWeightCalculator – species defaults", () => {
  it("uses different default yields for lamb and beef", () => {
    const beefResult = calculateButcheryWeights({
      species: "beef",
      liveWeightLb: 1200,
      count: 1
      // no explicit options: rely on species defaults
    });

    const lambResult = calculateButcheryWeights({
      species: "lamb",
      liveWeightLb: 120,
      count: 1
      // no explicit options: rely on species defaults
    });

    assertWeightsShape(beefResult);
    assertWeightsShape(lambResult);

    const bw = beefResult.weights;
    const lw = lambResult.weights;

    // Live weights should reflect inputs
    expect(bw.liveWeightPerHead).toBeCloseTo(1200, 3);
    expect(lw.liveWeightPerHead).toBeCloseTo(120, 3);

    // Dressing percentages typically similar or slightly higher for lamb.
    // We don't know exact defaults, but we can assert:
    expect(lw.dressedPerHead).toBeGreaterThan(0);
    expect(bw.dressedPerHead).toBeGreaterThan(0);

    const beefDressingPct =
      (bw.dressedPerHead / bw.liveWeightPerHead) * 100;
    const lambDressingPct =
      (lw.dressedPerHead / lw.liveWeightPerHead) * 100;

    expect(beefDressingPct).toBeGreaterThan(45);
    expect(beefDressingPct).toBeLessThan(70);

    expect(lambDressingPct).toBeGreaterThan(40);
    expect(lambDressingPct).toBeLessThan(75);

    // Retail yield for lamb should be a healthy fraction of live weight.
    const lambRetailPct =
      (lw.retailPerHead / lw.liveWeightPerHead) * 100;
    expect(lambRetailPct).toBeGreaterThan(30);
    expect(lambRetailPct).toBeLessThan(70);
  });
});

// -----------------------------------------------------------------------------
// 3) Count scaling – multiple animals
// -----------------------------------------------------------------------------

describe("ButcheryWeightCalculator – scales with animal count", () => {
  it("multiplies per-head weights by count to get totals", () => {
    const single = calculateButcheryWeights({
      species: "goat",
      liveWeightLb: 80,
      count: 1
    });

    const herd = calculateButcheryWeights({
      species: "goat",
      liveWeightLb: 80,
      count: 10
    });

    assertWeightsShape(single);
    assertWeightsShape(herd);

    const s = single.weights;
    const h = herd.weights;

    // Ratios for key weights should be ~10x.
    [
      "liveWeightTotal",
      "dressedTotal",
      "hangingTotal",
      "retailTotal"
    ].forEach((key) => {
      const ratio = h[key] / s[key];
      expect(ratio).toBeGreaterThan(9.7);
      expect(ratio).toBeLessThan(10.3);
    });
  });
});

// -----------------------------------------------------------------------------
// 4) Units – lb vs kg
// -----------------------------------------------------------------------------

describe("ButcheryWeightCalculator – unit conversion", () => {
  it("returns kg when units: 'kg' is specified", () => {
    const liveWeightLb = 250;
    const resultLb = calculateButcheryWeights({
      species: "pig",
      liveWeightLb,
      count: 1,
      options: {
        units: "lb",
        dressingPct: 72,
        shrinkPct: 2,
        cutoutPct: 78
      }
    });

    const resultKg = calculateButcheryWeights({
      species: "pig",
      liveWeightLb,
      count: 1,
      options: {
        units: "kg",
        dressingPct: 72,
        shrinkPct: 2,
        cutoutPct: 78
      }
    });

    assertWeightsShape(resultLb);
    assertWeightsShape(resultKg);

    const wLb = resultLb.weights;
    const wKg = resultKg.weights;

    const liveKgExpected = liveWeightLb * 0.45359237;
    expect(wKg.liveWeightPerHead).toBeCloseTo(liveKgExpected, 3);
    expect(wLb.liveWeightPerHead).toBeCloseTo(liveWeightLb, 3);

    // Hanging & retail should scale by same factor between units.
    const factor = wLb.hangingPerHead / wKg.hangingPerHead;
    expect(factor).toBeGreaterThan(2.0);
    expect(factor).toBeLessThan(2.5); // in the lb/kg range (~2.2)

    const factorRetail = wLb.retailPerHead / wKg.retailPerHead;
    expect(factorRetail).toBeGreaterThan(2.0);
    expect(factorRetail).toBeLessThan(2.5);
  });
});

// -----------------------------------------------------------------------------
// 5) Defensive behavior – invalid / extreme inputs
// -----------------------------------------------------------------------------

describe("ButcheryWeightCalculator – defensive behavior", () => {
  it("handles negative or extreme values without NaNs", () => {
    const result = calculateButcheryWeights({
      species: "",
      liveWeightLb: -1000,
      count: -3,
      options: {
        dressingPct: 999,
        shrinkPct: -50,
        cutoutPct: 1000,
        bonePct: -25,
        offalPct: 999,
        trimPct: -10,
        units: "lb"
      }
    });

    assertWeightsShape(result);

    const w = result.weights;

    // All values should be clamped to non-negative and finite.
    Object.values(w).forEach((value) => {
      assertNonNegativeFinite(value);
    });

    // For obviously broken inputs, live weights should resolve to 0 or
    // a very small value (no negative live weight).
    expect(w.liveWeightPerHead).toBeGreaterThanOrEqual(0);
    expect(w.liveWeightTotal).toBeGreaterThanOrEqual(0);

    // Total loss cannot exceed live weight.
    if (w.liveWeightPerHead > 0) {
      expect(w.totalLossPerHead).toBeLessThanOrEqual(
        w.liveWeightPerHead
      );
    }

    if (result.warnings && result.warnings.length > 0) {
      const joined = result.warnings.join(" ").toLowerCase();
      expect(
        joined.includes("invalid") ||
          joined.includes("clamped") ||
          joined.includes("out of range")
      ).toBe(true);
    }
  });
});

// -----------------------------------------------------------------------------
// 6) SSA integration sanity – homestead mixed batch
// -----------------------------------------------------------------------------

describe("ButcheryWeightCalculator – SSA integration sanity", () => {
  it("returns stable ranges for a mixed beef batch", () => {
    const result = calculateButcheryWeights({
      species: "beef",
      liveWeightLb: 1150,
      count: 2,
      options: {
        // Let species defaults work for bone/offal/trim, but pin dressing/shrink
        dressingPct: 62,
        shrinkPct: 3,
        units: "lb"
      }
    });

    assertWeightsShape(result);

    const w = result.weights;

    // Live total: ~2300 lb for 2 head
    expect(w.liveWeightTotal).toBeGreaterThan(2000);
    expect(w.liveWeightTotal).toBeLessThan(2600);

    // Hanging total typically 50–70% of live
    const hangingPctOfLive =
      (w.hangingTotal / w.liveWeightTotal) * 100;
    expect(hangingPctOfLive).toBeGreaterThan(45);
    expect(hangingPctOfLive).toBeLessThan(70);

    // Retail total typically ~35–65% of live
    const retailPctOfLive =
      (w.retailTotal / w.liveWeightTotal) * 100;
    expect(retailPctOfLive).toBeGreaterThan(30);
    expect(retailPctOfLive).toBeLessThan(70);

    // Ensure losses don't exceed live and are non-trivial.
    expect(w.totalLossTotal).toBeGreaterThan(0);
    expect(w.totalLossTotal).toBeLessThan(w.liveWeightTotal);
  });
});
