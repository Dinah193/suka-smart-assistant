// C:\Users\larho\suka-smart-assistant\src\tests\calculators\storehouseMeals\BatchYieldCalculator.test.js
// -----------------------------------------------------------------------------
// Unit tests for BatchYieldCalculator logic.
//
// ASSUMED PUBLIC API (you can implement to match this):
//
//   import { calculateBatchYield } from
//     "@/features/calculators/storehouseMeals/BatchYieldCalculator.logic.js";
//
//   const result = calculateBatchYield(config);
//
// Where `config` looks like:
//
//   {
//     baseBatch: {
//       servings: number,          // e.g. 4
//       durationMinutes: number,   // total active+passive minutes for the base batch
//       prepMinutes?: number,      // optional; default 0
//       cookMinutes?: number       // optional; default durationMinutes - prepMinutes
//     },
//     targetServings: number,      // desired servings, must be > 0
//     parallelCapacity?: number,   // ovens/racks/pots that can run at once (>= 1, default 1)
//     efficiencyCurve?: {          // optional for non-linear scaling
//       minEfficiency?: number,    // 0–1, e.g. 0.7
//       maxEfficiency?: number     // 0–1, e.g. 1.0
//     },
//     caps?: {
//       maxDurationMinutes?: number,   // clamp upper bound if needed
//       minDurationMinutes?: number    // clamp lower bound if needed
//     }
//   }
//
// And `calculateBatchYield(config)` returns:
//
//   {
//     targetServings: number,
//     scaleFactor: number,             // targetServings / baseBatch.servings (or adjusted)
//     adjustedDurationMinutes: number, // total minutes after scaling & efficiency
//     perUnitMinutes: number,          // adjustedDurationMinutes / targetServings
//     efficiency: number,              // 0–1 effective scaling efficiency
//     breakdown?: {                    // OPTIONAL: timing details
//       prepMinutes: number,
//       cookMinutes: number
//     },
//     method?: string,                 // e.g. "batch-yield-v1"
//     notes?: string                   // optional human-readable hints
//   }
//
// These tests intentionally emphasize relationships and sane ranges rather than
// exact formulas so you can safely iterate on the implementation without
// breaking SSA integration.
// -----------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import { calculateBatchYield } from "@/features/calculators/storehouseMeals/BatchYieldCalculator.logic.js";

const BASE_BATCH = Object.freeze({
  servings: 4,
  durationMinutes: 60,
  prepMinutes: 15,
  cookMinutes: 45
});

describe("BatchYieldCalculator.calculateBatchYield – basic shape", () => {
  it("returns an object with expected fields for a valid config", () => {
    const result = calculateBatchYield({
      baseBatch: BASE_BATCH,
      targetServings: 8
    });

    expect(result).toBeTruthy();
    expect(typeof result).toBe("object");

    expect(typeof result.targetServings).toBe("number");
    expect(typeof result.scaleFactor).toBe("number");
    expect(typeof result.adjustedDurationMinutes).toBe("number");
    expect(typeof result.perUnitMinutes).toBe("number");
    expect(typeof result.efficiency).toBe("number");

    // Optional fields
    if (result.breakdown) {
      expect(typeof result.breakdown).toBe("object");
      expect(typeof result.breakdown.prepMinutes).toBe("number");
      expect(typeof result.breakdown.cookMinutes).toBe("number");
      const totalBreakdown =
        result.breakdown.prepMinutes + result.breakdown.cookMinutes;
      // allow small rounding differences
      const diff = Math.abs(totalBreakdown - result.adjustedDurationMinutes);
      expect(diff).toBeLessThan(2);
    }

    if (result.method) {
      expect(typeof result.method).toBe("string");
    }
    if (result.notes) {
      expect(typeof result.notes).toBe("string");
    }

    // Sanity ranges
    expect(result.targetServings).toBeGreaterThan(0);
    expect(result.scaleFactor).toBeGreaterThan(0);
    expect(result.adjustedDurationMinutes).toBeGreaterThan(0);
    expect(result.adjustedDurationMinutes).toBeLessThan(24 * 60); // < 24 hours
    expect(result.efficiency).toBeGreaterThan(0);
    expect(result.efficiency).toBeLessThanOrEqual(1);
  });

  it("uses scaleFactor ≈ targetServings / baseServings", () => {
    const config = {
      baseBatch: BASE_BATCH,
      targetServings: 10
    };
    const expectedScale = config.targetServings / config.baseBatch.servings;

    const result = calculateBatchYield(config);

    expect(result.scaleFactor).toBeGreaterThan(0);
    const diff = Math.abs(result.scaleFactor - expectedScale);
    expect(diff).toBeLessThan(0.05); // 5% tolerance
  });
});

describe("BatchYieldCalculator.calculateBatchYield – scaling relationships", () => {
  it("increases adjustedDurationMinutes when scaleFactor > 1 (no parallel capacity hints)", () => {
    const baseResult = calculateBatchYield({
      baseBatch: BASE_BATCH,
      targetServings: BASE_BATCH.servings
    });

    const doubleResult = calculateBatchYield({
      baseBatch: BASE_BATCH,
      targetServings: BASE_BATCH.servings * 2
    });

    // Double batch should not take *less* time than the base batch
    expect(doubleResult.adjustedDurationMinutes).toBeGreaterThanOrEqual(
      baseResult.adjustedDurationMinutes
    );
  });

  it("decreases perUnitMinutes when batch becomes larger but optimized (efficiency)", () => {
    const single = calculateBatchYield({
      baseBatch: BASE_BATCH,
      targetServings: BASE_BATCH.servings,
      efficiencyCurve: {
        minEfficiency: 0.6,
        maxEfficiency: 0.9
      }
    });

    const bigger = calculateBatchYield({
      baseBatch: BASE_BATCH,
      targetServings: BASE_BATCH.servings * 3,
      efficiencyCurve: {
        minEfficiency: 0.6,
        maxEfficiency: 0.9
      }
    });

    // Larger batch should generally get better per-unit efficiency
    expect(bigger.perUnitMinutes).toBeLessThanOrEqual(single.perUnitMinutes);
  });

  it("applies parallelCapacity to avoid purely linear time growth", () => {
    const noParallel = calculateBatchYield({
      baseBatch: BASE_BATCH,
      targetServings: 16,
      parallelCapacity: 1
    });

    const parallel = calculateBatchYield({
      baseBatch: BASE_BATCH,
      targetServings: 16,
      parallelCapacity: 4
    });

    // Parallel capacity should reduce overall adjusted duration
    expect(parallel.adjustedDurationMinutes).toBeLessThanOrEqual(
      noParallel.adjustedDurationMinutes
    );
  });

  it("caps adjustedDurationMinutes within provided caps if set", () => {
    const result = calculateBatchYield({
      baseBatch: BASE_BATCH,
      targetServings: 100,
      caps: {
        maxDurationMinutes: 6 * 60 // 6 hours
      }
    });

    expect(result.adjustedDurationMinutes).toBeLessThanOrEqual(6 * 60);
  });
});

describe("BatchYieldCalculator.calculateBatchYield – prep vs cook breakdown", () => {
  it("preserves prepMinutes as mostly non-scaled vs cookMinutes scaled with batch size", () => {
    const base = calculateBatchYield({
      baseBatch: BASE_BATCH,
      targetServings: BASE_BATCH.servings
    });

    const scaled = calculateBatchYield({
      baseBatch: BASE_BATCH,
      targetServings: BASE_BATCH.servings * 2
    });

    // If breakdown is not provided, we can't test this behavior directly
    if (!base.breakdown || !scaled.breakdown) {
      // If breakdown is missing, ensure still logically consistent
      expect(base.adjustedDurationMinutes).toBeGreaterThan(0);
      expect(scaled.adjustedDurationMinutes).toBeGreaterThan(
        base.adjustedDurationMinutes
      );
      return;
    }

    // Prep is more "fixed" overhead; scaled prep may grow, but not as fast as cookMinutes
    const prepGrowth =
      scaled.breakdown.prepMinutes - base.breakdown.prepMinutes;
    const cookGrowth =
      scaled.breakdown.cookMinutes - base.breakdown.cookMinutes;

    // It's okay if prep grows some, but it should be relatively smaller than cook growth
    expect(cookGrowth).toBeGreaterThanOrEqual(prepGrowth);
  });

  it("keeps breakdown sums close to adjustedDurationMinutes after scaling", () => {
    const result = calculateBatchYield({
      baseBatch: BASE_BATCH,
      targetServings: 12
    });

    if (!result.breakdown) return;

    const totalBreakdown =
      result.breakdown.prepMinutes + result.breakdown.cookMinutes;
    const diff = Math.abs(totalBreakdown - result.adjustedDurationMinutes);
    expect(diff).toBeLessThan(3); // allow small rounding/efficiency rounding
  });
});

describe("BatchYieldCalculator.calculateBatchYield – efficiency curve behavior", () => {
  it("respects efficiency bounds between minEfficiency and maxEfficiency", () => {
    const config = {
      baseBatch: BASE_BATCH,
      targetServings: 12,
      efficiencyCurve: {
        minEfficiency: 0.65,
        maxEfficiency: 0.95
      }
    };

    const result = calculateBatchYield(config);

    expect(result.efficiency).toBeGreaterThanOrEqual(
      config.efficiencyCurve.minEfficiency
    );
    expect(result.efficiency).toBeLessThanOrEqual(
      config.efficiencyCurve.maxEfficiency
    );
  });

  it("increases efficiency as batch size grows from base to larger batch", () => {
    const base = calculateBatchYield({
      baseBatch: BASE_BATCH,
      targetServings: BASE_BATCH.servings,
      efficiencyCurve: {
        minEfficiency: 0.7,
        maxEfficiency: 0.95
      }
    });

    const triple = calculateBatchYield({
      baseBatch: BASE_BATCH,
      targetServings: BASE_BATCH.servings * 3,
      efficiencyCurve: {
        minEfficiency: 0.7,
        maxEfficiency: 0.95
      }
    });

    expect(triple.efficiency).toBeGreaterThanOrEqual(base.efficiency);
  });
});

describe("BatchYieldCalculator.calculateBatchYield – guardrails and invalid inputs", () => {
  it("throws or returns a non-valid result for invalid targetServings or baseBatch", () => {
    const configs = [
      { baseBatch: BASE_BATCH, targetServings: 0 },
      { baseBatch: BASE_BATCH, targetServings: -5 },
      { baseBatch: { ...BASE_BATCH, servings: 0 }, targetServings: 8 },
      { baseBatch: { ...BASE_BATCH, servings: -3 }, targetServings: 8 }
    ];

    configs.forEach((config) => {
      let threw = false;
      let result = undefined;

      try {
        result = calculateBatchYield(config);
      } catch (err) {
        threw = true;
      }

      if (!threw) {
        // If it did not throw, ensure we did NOT get a normal-looking result
        const looksValid =
          result &&
          typeof result === "object" &&
          typeof result.targetServings === "number" &&
          result.targetServings > 0 &&
          typeof result.adjustedDurationMinutes === "number" &&
          result.adjustedDurationMinutes > 0;

        expect(looksValid).toBe(false);
      }
    });
  });

  it("handles missing optional fields by falling back to reasonable defaults", () => {
    const result = calculateBatchYield({
      baseBatch: {
        servings: 4,
        durationMinutes: 50
        // no explicit prep/cook breakdown
      },
      targetServings: 6
    });

    expect(result).toBeTruthy();
    expect(result.targetServings).toBe(6);
    expect(result.scaleFactor).toBeGreaterThan(0);
    expect(result.adjustedDurationMinutes).toBeGreaterThan(0);
  });
});

describe("BatchYieldCalculator.calculateBatchYield – storehouse / SSA integration hints", () => {
  it("produces perUnitMinutes that can be used to compare across recipes", () => {
    const stew = calculateBatchYield({
      baseBatch: {
        servings: 4,
        durationMinutes: 120,
        prepMinutes: 30,
        cookMinutes: 90
      },
      targetServings: 8
    });

    const quickBread = calculateBatchYield({
      baseBatch: {
        servings: 12,
        durationMinutes: 45,
        prepMinutes: 15,
        cookMinutes: 30
      },
      targetServings: 24
    });

    expect(stew.perUnitMinutes).toBeGreaterThan(0);
    expect(quickBread.perUnitMinutes).toBeGreaterThan(0);

    // This assertion is intentionally weak: it just confirms cross-batch
    // numbers are on a comparable scale, not which one *should* be bigger.
    const maxReasonablePerUnit = 240; // < 4h per serving
    expect(stew.perUnitMinutes).toBeLessThan(maxReasonablePerUnit);
    expect(quickBread.perUnitMinutes).toBeLessThan(maxReasonablePerUnit);
  });

  it("sets method string (if present) in a way that clearly identifies the calculator", () => {
    const result = calculateBatchYield({
      baseBatch: BASE_BATCH,
      targetServings: 8
    });

    if (!result.method) return;

    expect(result.method.toLowerCase()).toContain("batch");
    expect(result.method.toLowerCase()).toContain("yield");
  });
});
