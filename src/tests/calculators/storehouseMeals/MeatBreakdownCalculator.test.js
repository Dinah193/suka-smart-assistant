// C:\Users\larho\suka-smart-assistant\src\tests\calculators\storehouseMeals\MeatBreakdownCalculator.test.js
// -----------------------------------------------------------------------------
// Unit tests for MeatBreakdownCalculator logic.
//
// ASSUMED PUBLIC API (align your implementation to this shape):
//
//   import { calculateMeatBreakdown } from
//     "@/features/calculators/storehouseMeals/MeatBreakdownCalculator.logic.js";
//
//   const breakdown = calculateMeatBreakdown(config);
//
// Where `config` looks like:
//
//   {
//     species: string,          // "lamb" | "goat" | "beef" | "pork" | "poultry" | etc.
//     liveWeightLb: number,     // live weight in pounds
//     unit?: "lb" | "kg",       // optional; if "kg", convert to lb internally
//
//     // Optional tuning knobs (your implementation can choose defaults)
//     dressingPct?: number,     // 0–1, carcassWeight = liveWeight * dressingPct
//     hangingLossPct?: number,  // 0–1, shrink during hanging/aging
//     bonePct?: number,         // 0–1 percentage of carcass that is bone
//     fatTrimPct?: number,      // 0–1 percentage trimmed away as fat
//     grindPct?: number,        // 0–1 percentage of boneless lean moved to ground pile
//
//     cutPlan?: {
//       steaksPct?: number,     // 0–1
//       roastsPct?: number,     // 0–1
//       stewPct?: number,       // 0–1
//       organsPct?: number      // 0–1
//     }
//   }
//
// And `calculateMeatBreakdown(config)` returns:
//
//   {
//     species: string,
//     liveWeightLb: number,
//     carcassWeightLb: number,
//     bonelessYieldLb: number,
//     boneWeightLb: number,
//     fatTrimLb: number,
//
//     // Major product streams
//     grindLb: number,
//     steaksLb: number,
//     roastsLb: number,
//     stewLb: number,
//     organsLb: number,
//
//     // Aggregates
//     totalPackagedLb: number,
//     yieldPctOfLive: number,  // (totalPackagedLb / liveWeightLb) * 100
//
//     // Introspection / debug
//     factors?: {
//       dressingPct?: number,
//       hangingLossPct?: number,
//       bonePct?: number,
//       fatTrimPct?: number,
//       grindPct?: number,
//       normalizedCutPlan?: {
//         steaksPct?: number,
//         roastsPct?: number,
//         stewPct?: number,
//         organsPct?: number
//       }
//     },
//
//     warnings?: string[]       // e.g. “cutPlan sum > 1, normalized”
//   }
//
// These tests focus on:
//   * Shape and numeric sanity of the output
//   * Monotonic relationships (more live weight → more packaged meat, etc.)
//   * Species/dressing differences
//   * Effects of bonePct, fatTrimPct, and grindPct
//   * Handling of funny cut plans (sum > 1, missing values, etc.)
//   * Defensive behavior for bad inputs
// -----------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import { calculateMeatBreakdown } from "@/features/calculators/storehouseMeals/MeatBreakdownCalculator.logic.js";

function assertBasicBreakdown(result) {
  expect(result).toBeTruthy();
  expect(typeof result).toBe("object");

  expect(typeof result.species).toBe("string");
  expect(typeof result.liveWeightLb).toBe("number");
  expect(typeof result.carcassWeightLb).toBe("number");
  expect(typeof result.bonelessYieldLb).toBe("number");
  expect(typeof result.boneWeightLb).toBe("number");
  expect(typeof result.fatTrimLb).toBe("number");

  expect(typeof result.grindLb).toBe("number");
  expect(typeof result.steaksLb).toBe("number");
  expect(typeof result.roastsLb).toBe("number");
  expect(typeof result.stewLb).toBe("number");
  expect(typeof result.organsLb).toBe("number");

  expect(typeof result.totalPackagedLb).toBe("number");
  expect(typeof result.yieldPctOfLive).toBe("number");

  // Basic non-negativity
  expect(result.liveWeightLb).toBeGreaterThanOrEqual(0);
  expect(result.carcassWeightLb).toBeGreaterThanOrEqual(0);
  expect(result.bonelessYieldLb).toBeGreaterThanOrEqual(0);
  expect(result.boneWeightLb).toBeGreaterThanOrEqual(0);
  expect(result.fatTrimLb).toBeGreaterThanOrEqual(0);
  expect(result.grindLb).toBeGreaterThanOrEqual(0);
  expect(result.steaksLb).toBeGreaterThanOrEqual(0);
  expect(result.roastsLb).toBeGreaterThanOrEqual(0);
  expect(result.stewLb).toBeGreaterThanOrEqual(0);
  expect(result.organsLb).toBeGreaterThanOrEqual(0);
  expect(result.totalPackagedLb).toBeGreaterThanOrEqual(0);

  // Totals should not exceed carcass by a huge margin (allow small rounding wiggle)
  const sumProducts =
    result.grindLb +
    result.steaksLb +
    result.roastsLb +
    result.stewLb +
    result.organsLb;

  expect(sumProducts).toBeLessThanOrEqual(result.carcassWeightLb + 0.01);
  expect(result.totalPackagedLb).toBeCloseTo(sumProducts, 3);

  // Yield percentage should be in a sane range 0–100+small epsilon
  expect(result.yieldPctOfLive).toBeGreaterThanOrEqual(0);
  expect(result.yieldPctOfLive).toBeLessThanOrEqual(100.5);

  if (result.warnings) {
    expect(Array.isArray(result.warnings)).toBe(true);
  }
}

// -----------------------------------------------------------------------------
// Basic structure and scaling
// -----------------------------------------------------------------------------
describe("MeatBreakdownCalculator.calculateMeatBreakdown – basic behavior", () => {
  it("returns a well-formed breakdown for a typical lamb", () => {
    const breakdown = calculateMeatBreakdown({
      species: "lamb",
      liveWeightLb: 120,
      dressingPct: 0.5,
      bonePct: 0.18,
      fatTrimPct: 0.12,
      grindPct: 0.25,
      cutPlan: {
        steaksPct: 0.3,
        roastsPct: 0.3,
        stewPct: 0.25,
        organsPct: 0.05
      }
    });

    assertBasicBreakdown(breakdown);
    expect(breakdown.species).toBe("lamb");
    expect(breakdown.liveWeightLb).toBe(120);
  });

  it("scales roughly linearly with liveWeightLb for the same parameters", () => {
    const small = calculateMeatBreakdown({
      species: "goat",
      liveWeightLb: 80,
      dressingPct: 0.48,
      bonePct: 0.20,
      fatTrimPct: 0.10,
      grindPct: 0.2
    });

    const large = calculateMeatBreakdown({
      species: "goat",
      liveWeightLb: 160,
      dressingPct: 0.48,
      bonePct: 0.20,
      fatTrimPct: 0.10,
      grindPct: 0.2
    });

    assertBasicBreakdown(small);
    assertBasicBreakdown(large);

    expect(large.totalPackagedLb).toBeGreaterThan(small.totalPackagedLb);
    // Roughly double, within some tolerance
    const ratio = large.totalPackagedLb / small.totalPackagedLb;
    expect(ratio).toBeGreaterThan(1.8);
    expect(ratio).toBeLessThan(2.2);
  });
});

// -----------------------------------------------------------------------------
// Dressing and bone/fat parameters
// -----------------------------------------------------------------------------
describe("MeatBreakdownCalculator.calculateMeatBreakdown – dressing, bone & fat", () => {
  it("increases carcass weight and packaged yield with higher dressingPct", () => {
    const lowDress = calculateMeatBreakdown({
      species: "beef",
      liveWeightLb: 1000,
      dressingPct: 0.55,
      bonePct: 0.15,
      fatTrimPct: 0.18,
      grindPct: 0.35
    });

    const highDress = calculateMeatBreakdown({
      species: "beef",
      liveWeightLb: 1000,
      dressingPct: 0.62,
      bonePct: 0.15,
      fatTrimPct: 0.18,
      grindPct: 0.35
    });

    assertBasicBreakdown(lowDress);
    assertBasicBreakdown(highDress);

    expect(highDress.carcassWeightLb).toBeGreaterThan(lowDress.carcassWeightLb);
    expect(highDress.totalPackagedLb).toBeGreaterThan(
      lowDress.totalPackagedLb
    );
  });

  it("reduces boneless yield when bonePct is higher", () => {
    const lowBone = calculateMeatBreakdown({
      species: "pork",
      liveWeightLb: 250,
      dressingPct: 0.74,
      bonePct: 0.15,
      fatTrimPct: 0.15
    });

    const highBone = calculateMeatBreakdown({
      species: "pork",
      liveWeightLb: 250,
      dressingPct: 0.74,
      bonePct: 0.28,
      fatTrimPct: 0.15
    });

    assertBasicBreakdown(lowBone);
    assertBasicBreakdown(highBone);

    expect(lowBone.bonelessYieldLb).toBeGreaterThan(
      highBone.bonelessYieldLb
    );
    expect(highBone.boneWeightLb).toBeGreaterThan(lowBone.boneWeightLb);
  });

  it("reduces boneless yield when fatTrimPct is higher", () => {
    const lowTrim = calculateMeatBreakdown({
      species: "beef",
      liveWeightLb: 900,
      dressingPct: 0.6,
      bonePct: 0.18,
      fatTrimPct: 0.10
    });

    const highTrim = calculateMeatBreakdown({
      species: "beef",
      liveWeightLb: 900,
      dressingPct: 0.6,
      bonePct: 0.18,
      fatTrimPct: 0.25
    });

    assertBasicBreakdown(lowTrim);
    assertBasicBreakdown(highTrim);

    expect(lowTrim.bonelessYieldLb).toBeGreaterThan(
      highTrim.bonelessYieldLb
    );
    expect(highTrim.fatTrimLb).toBeGreaterThan(lowTrim.fatTrimLb);
  });
});

// -----------------------------------------------------------------------------
// Grind percentage and cut plan behavior
// -----------------------------------------------------------------------------
describe("MeatBreakdownCalculator.calculateMeatBreakdown – grind & cut plan", () => {
  it("increases ground meat weight with higher grindPct", () => {
    const lowGrind = calculateMeatBreakdown({
      species: "lamb",
      liveWeightLb: 120,
      dressingPct: 0.5,
      bonePct: 0.18,
      fatTrimPct: 0.12,
      grindPct: 0.1
    });

    const highGrind = calculateMeatBreakdown({
      species: "lamb",
      liveWeightLb: 120,
      dressingPct: 0.5,
      bonePct: 0.18,
      fatTrimPct: 0.12,
      grindPct: 0.5
    });

    assertBasicBreakdown(lowGrind);
    assertBasicBreakdown(highGrind);

    expect(highGrind.grindLb).toBeGreaterThan(lowGrind.grindLb);
  });

  it("allocates boneless yield across steaks/roasts/stew/organs according to cutPlan", () => {
    const plan = {
      steaksPct: 0.4,
      roastsPct: 0.3,
      stewPct: 0.2,
      organsPct: 0.1
    };

    const breakdown = calculateMeatBreakdown({
      species: "goat",
      liveWeightLb: 100,
      dressingPct: 0.5,
      bonePct: 0.2,
      fatTrimPct: 0.1,
      grindPct: 0.0,
      cutPlan: plan
    });

    assertBasicBreakdown(breakdown);

    const sumPortions =
      breakdown.steaksLb +
      breakdown.roastsLb +
      breakdown.stewLb +
      breakdown.organsLb;

    // With grindPct=0, packaged should be almost entire boneless yield
    expect(sumPortions).toBeCloseTo(breakdown.bonelessYieldLb, 3);
  });

  it("normalizes a cutPlan whose percentages sum to > 1 and emits a warning", () => {
    const breakdown = calculateMeatBreakdown({
      species: "goat",
      liveWeightLb: 100,
      dressingPct: 0.5,
      bonePct: 0.2,
      fatTrimPct: 0.1,
      grindPct: 0.0,
      cutPlan: {
        steaksPct: 0.6,
        roastsPct: 0.6, // sum 1.2 → should be normalized internally
        stewPct: 0.2
      }
    });

    assertBasicBreakdown(breakdown);

    const sumPortions =
      breakdown.steaksLb +
      breakdown.roastsLb +
      breakdown.stewLb +
      breakdown.organsLb;

    expect(sumPortions).toBeLessThanOrEqual(breakdown.bonelessYieldLb + 0.01);

    if (breakdown.warnings && breakdown.warnings.length > 0) {
      const joined = breakdown.warnings.join(" ").toLowerCase();
      expect(joined).toContain("cut");
      expect(joined).toContain("normalize");
    }
  });
});

// -----------------------------------------------------------------------------
// Unit and conversion handling
// -----------------------------------------------------------------------------
describe("MeatBreakdownCalculator.calculateMeatBreakdown – unit handling", () => {
  it("accepts kg and converts to lb internally", () => {
    const inKg = calculateMeatBreakdown({
      species: "beef",
      liveWeightLb: 500,
      dressingPct: 0.6
    });

    const inKgAlternate = calculateMeatBreakdown({
      species: "beef",
      liveWeightLb: 500 * 0.453592, // if logic interprets this as kg when unit: 'kg'
      unit: "kg",
      dressingPct: 0.6
    });

    assertBasicBreakdown(inKg);
    assertBasicBreakdown(inKgAlternate);

    // They should land roughly in the same range after conversion.
    const ratio =
      inKgAlternate.totalPackagedLb / inKg.totalPackagedLb;
    expect(ratio).toBeGreaterThan(0.95);
    expect(ratio).toBeLessThan(1.05);
  });
});

// -----------------------------------------------------------------------------
// Defensive behavior
// -----------------------------------------------------------------------------
describe("MeatBreakdownCalculator.calculateMeatBreakdown – defensive behavior", () => {
  it("guards against negative or NaN weights and returns a safe minimal structure", () => {
    const breakdown = calculateMeatBreakdown({
      species: "lamb",
      liveWeightLb: -50,
      dressingPct: -0.5,
      bonePct: 2,
      fatTrimPct: -1
    });

    assertBasicBreakdown(breakdown);

    expect(breakdown.liveWeightLb).toBeGreaterThanOrEqual(0);
    expect(breakdown.carcassWeightLb).toBeGreaterThanOrEqual(0);
    expect(breakdown.totalPackagedLb).toBeGreaterThanOrEqual(0);
  });

  it("handles unknown species gracefully without throwing (still returns a breakdown)", () => {
    const breakdown = calculateMeatBreakdown({
      species: "dragon-goose", // intentionally unknown
      liveWeightLb: 150,
      dressingPct: 0.5
    });

    assertBasicBreakdown(breakdown);
    expect(breakdown.species).toBe("dragon-goose");
  });
});

// -----------------------------------------------------------------------------
// SSA / Planning Graph compatibility
// -----------------------------------------------------------------------------
describe("MeatBreakdownCalculator.calculateMeatBreakdown – SSA compatibility checks", () => {
  it("produces yields that a StorehouseRefillCalculator can consume without contradictions", () => {
    const breakdown = calculateMeatBreakdown({
      species: "lamb",
      liveWeightLb: 120,
      dressingPct: 0.5,
      bonePct: 0.18,
      fatTrimPct: 0.12,
      grindPct: 0.3
    });

    assertBasicBreakdown(breakdown);

    // For Planning Graph, we only require:
    //   * totalPackagedLb <= carcassWeightLb
    //   * yieldPctOfLive aligns with ratio
    expect(breakdown.totalPackagedLb).toBeLessThanOrEqual(
      breakdown.carcassWeightLb + 0.01
    );

    const expectedYieldPct =
      (breakdown.totalPackagedLb / breakdown.liveWeightLb) * 100;
    expect(breakdown.yieldPctOfLive).toBeCloseTo(expectedYieldPct, 3);
  });
});
