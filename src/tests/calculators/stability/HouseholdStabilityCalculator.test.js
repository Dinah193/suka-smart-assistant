// C:\Users\larho\suka-smart-assistant\src\tests\calculators\stability\HouseholdStabilityCalculator.test.js
// -----------------------------------------------------------------------------
// Unit tests for HouseholdStabilityCalculator
//
// PURPOSE
// -------
// Validates that the HouseholdStabilityCalculator:
//
//  * Produces a stable, well-typed result object.
//  * Aggregates multiple stability dimensions into a single totalScore.
//  * Computes consistent per-dimension scores and normalized radar values.
//  * Respects weight configuration when computing the aggregate score.
//  * Responds monotonically when a dimension improves or worsens.
//  * Handles missing or partial dimensions gracefully with meta notes.
//  * Behaves deterministically for identical inputs.
//
// ASSUMED PUBLIC API
// ------------------
//
//   import { calculateHouseholdStability } from
//     "@/features/calculators/stability/HouseholdStabilityCalculator.logic.js";
//
//   const result = calculateHouseholdStability({
//     finances: {
//       incomeStability: number,        // 0–1
//       emergencyFundMonths: number,    // 0+
//       debtToIncomeRatio: number       // 0–1
//     },
//     food: {
//       storehouseDays: number,         // 0+
//       gardenReliance: number,         // 0–1
//       preservationCapacity: number    // 0–1
//     },
//     housing: {
//       tenureSecurity: number,         // 0–1
//       repairBacklog: number,          // 0+ (higher = worse)
//       disasterRisk: number            // 0–1 (higher = worse)
//     },
//     health: {
//       insuranceCoverage: number,      // 0–1
//       chronicConditionsManaged: number,// 0–1
//       activityLevel: number           // 0–1
//     },
//     community: {
//       mutualAidTier: number,          // 0–3
//       localFamily: number,            // 0–1
//       congregation: number            // 0–1
//     },
//     preparedness: {
//       blackoutDaysCovered: number,    // 0+
//       waterDaysCovered: number,       // 0+
//       altCooking: number              // 0–1
//     },
//     weights?: {
//       finances?: number,
//       food?: number,
//       housing?: number,
//       health?: number,
//       community?: number,
//       preparedness?: number
//     }
//   });
//
// RESULT SHAPE (minimum used in tests)
// ------------------------------------
//
//   {
//     totalScore: number,               // 0–100
//     band: string,                     // e.g. "fragile" | "vulnerable" | "stable" | "resilient"
//     dimensions: Array<{
//       key: string,                    // "finances" | "food" | ...
//       label: string,
//       score: number,                  // 0–100
//       weight: number                  // normalized weight (0–1) or raw, but >=0
//     }>,
//     radar: {
//       finances: number,               // 0–1
//       food: number,                   // 0–1
//       housing: number,                // 0–1
//       health: number,                 // 0–1
//       community: number,              // 0–1
//       preparedness: number            // 0–1
//     },
//     meta: {
//       appliedWeights: Record<string, number>,
//       notes: string[]
//     }
//   }
//
// Tests are written to be **invariant-focused** so the internal scoring
// implementation can evolve without breaking SSA Planning Graph or
// SessionRunner integrations.
// -----------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import { calculateHouseholdStability } from "@/features/calculators/stability/HouseholdStabilityCalculator.logic.js";

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/**
 * Asserts that the calculator result has the expected shape and sane ranges.
 * @param {any} result
 */
function expectStabilityResultShape(result) {
  expect(result).toBeTruthy();
  expect(typeof result).toBe("object");

  // totalScore
  expect(typeof result.totalScore).toBe("number");
  expect(result.totalScore).toBeGreaterThanOrEqual(0);
  expect(result.totalScore).toBeLessThanOrEqual(100);

  // band
  expect(typeof result.band).toBe("string");
  expect(result.band.length).toBeGreaterThan(0);

  // dimensions
  expect(Array.isArray(result.dimensions)).toBe(true);
  expect(result.dimensions.length).toBeGreaterThan(0);

  const seenKeys = new Set();
  result.dimensions.forEach((dim) => {
    expect(typeof dim.key).toBe("string");
    expect(dim.key.length).toBeGreaterThan(0);
    expect(typeof dim.label).toBe("string");
    expect(dim.label.length).toBeGreaterThan(0);
    expect(typeof dim.score).toBe("number");
    expect(dim.score).toBeGreaterThanOrEqual(0);
    expect(dim.score).toBeLessThanOrEqual(100);
    expect(typeof dim.weight).toBe("number");
    expect(dim.weight).toBeGreaterThanOrEqual(0);
    seenKeys.add(dim.key);
  });

  // radar
  expect(result.radar).toBeTruthy();
  expect(typeof result.radar).toBe("object");
  ["finances", "food", "housing", "health", "community", "preparedness"].forEach(
    (key) => {
      expect(result.radar).toHaveProperty(key);
      const val = result.radar[key];
      expect(typeof val).toBe("number");
      expect(val).toBeGreaterThanOrEqual(0);
      expect(val).toBeLessThanOrEqual(1);
    }
  );

  // meta
  expect(result.meta).toBeTruthy();
  expect(typeof result.meta).toBe("object");
  expect(result.meta.appliedWeights).toBeTruthy();
  expect(typeof result.meta.appliedWeights).toBe("object");
  Object.values(result.meta.appliedWeights).forEach((w) => {
    expect(typeof w).toBe("number");
    expect(w).toBeGreaterThanOrEqual(0);
  });
  expect(Array.isArray(result.meta.notes)).toBe(true);
}

// Convenience: create a "baseline" household input
function makeBaselineInput() {
  return {
    finances: {
      incomeStability: 0.6,
      emergencyFundMonths: 2,
      debtToIncomeRatio: 0.4
    },
    food: {
      storehouseDays: 30,
      gardenReliance: 0.3,
      preservationCapacity: 0.4
    },
    housing: {
      tenureSecurity: 0.7,
      repairBacklog: 2,
      disasterRisk: 0.3
    },
    health: {
      insuranceCoverage: 0.8,
      chronicConditionsManaged: 0.6,
      activityLevel: 0.5
    },
    community: {
      mutualAidTier: 1,
      localFamily: 0.5,
      congregation: 0.4
    },
    preparedness: {
      blackoutDaysCovered: 3,
      waterDaysCovered: 3,
      altCooking: 0.3
    }
  };
}

// -----------------------------------------------------------------------------
// 1) Basic invariants and shape
// -----------------------------------------------------------------------------

describe("HouseholdStabilityCalculator – basic shape and invariants", () => {
  it("returns a well-shaped result for a typical household input", () => {
    const result = calculateHouseholdStability(makeBaselineInput());
    expectStabilityResultShape(result);

    // totalScore should be > 0 given non-empty inputs
    expect(result.totalScore).toBeGreaterThan(0);
  });

  it("is deterministic for identical inputs", () => {
    const input = makeBaselineInput();
    const res1 = calculateHouseholdStability(input);
    const res2 = calculateHouseholdStability(input);

    expectStabilityResultShape(res1);
    expectStabilityResultShape(res2);

    expect(res1.totalScore).toBeCloseTo(res2.totalScore);
    expect(res1.band).toBe(res2.band);
    expect(res1.dimensions.length).toBe(res2.dimensions.length);
  });
});

// -----------------------------------------------------------------------------
// 2) Monotonic behavior – improving a dimension raises its score & totalScore
// -----------------------------------------------------------------------------

describe("HouseholdStabilityCalculator – monotonic responses", () => {
  it("increases totalScore when finances clearly improve", () => {
    const baseline = makeBaselineInput();
    const worseFinances = {
      ...baseline,
      finances: {
        incomeStability: 0.3,
        emergencyFundMonths: 0,
        debtToIncomeRatio: 0.8
      }
    };
    const betterFinances = {
      ...baseline,
      finances: {
        incomeStability: 0.9,
        emergencyFundMonths: 6,
        debtToIncomeRatio: 0.1
      }
    };

    const worseResult = calculateHouseholdStability(worseFinances);
    const betterResult = calculateHouseholdStability(betterFinances);

    expectStabilityResultShape(worseResult);
    expectStabilityResultShape(betterResult);

    // better finances should not produce a lower overall score
    expect(betterResult.totalScore).toBeGreaterThan(worseResult.totalScore);

    const worseFinDim = worseResult.dimensions.find((d) => d.key === "finances");
    const betterFinDim = betterResult.dimensions.find((d) => d.key === "finances");

    expect(worseFinDim).toBeTruthy();
    expect(betterFinDim).toBeTruthy();
    expect(betterFinDim.score).toBeGreaterThan(worseFinDim.score);
  });

  it("increases the food dimension and overall score as storehouseDays grows", () => {
    const baseline = makeBaselineInput();

    const shortFood = {
      ...baseline,
      food: {
        storehouseDays: 3,
        gardenReliance: 0.0,
        preservationCapacity: 0.1
      }
    };

    const longFood = {
      ...baseline,
      food: {
        storehouseDays: 120,
        gardenReliance: 0.7,
        preservationCapacity: 0.8
      }
    };

    const shortRes = calculateHouseholdStability(shortFood);
    const longRes = calculateHouseholdStability(longFood);

    expectStabilityResultShape(shortRes);
    expectStabilityResultShape(longRes);

    const shortFoodDim = shortRes.dimensions.find((d) => d.key === "food");
    const longFoodDim = longRes.dimensions.find((d) => d.key === "food");

    expect(shortFoodDim).toBeTruthy();
    expect(longFoodDim).toBeTruthy();
    expect(longFoodDim.score).toBeGreaterThan(shortFoodDim.score);

    // totalScore should also trend upward
    expect(longRes.totalScore).toBeGreaterThan(shortRes.totalScore);
  });
});

// -----------------------------------------------------------------------------
// 3) Weighting behavior – heavier weights magnify influence
// -----------------------------------------------------------------------------

describe("HouseholdStabilityCalculator – weighting behavior", () => {
  it("gives finances more influence when finance weight is increased", () => {
    const baseline = makeBaselineInput();

    // Two households: same everything except finances
    const lowFinances = {
      ...baseline,
      finances: {
        incomeStability: 0.2,
        emergencyFundMonths: 0,
        debtToIncomeRatio: 0.9
      }
    };

    const highFinances = {
      ...baseline,
      finances: {
        incomeStability: 0.95,
        emergencyFundMonths: 6,
        debtToIncomeRatio: 0.1
      }
    };

    // Scenario A: equal weights
    const equalWeightsResLow = calculateHouseholdStability({
      ...lowFinances,
      weights: {
        finances: 1,
        food: 1,
        housing: 1,
        health: 1,
        community: 1,
        preparedness: 1
      }
    });
    const equalWeightsResHigh = calculateHouseholdStability({
      ...highFinances,
      weights: {
        finances: 1,
        food: 1,
        housing: 1,
        health: 1,
        community: 1,
        preparedness: 1
      }
    });

    // Scenario B: finance-heavy weights
    const financeHeavyResLow = calculateHouseholdStability({
      ...lowFinances,
      weights: {
        finances: 3,
        food: 1,
        housing: 1,
        health: 1,
        community: 1,
        preparedness: 1
      }
    });
    const financeHeavyResHigh = calculateHouseholdStability({
      ...highFinances,
      weights: {
        finances: 3,
        food: 1,
        housing: 1,
        health: 1,
        community: 1,
        preparedness: 1
      }
    });

    expectStabilityResultShape(equalWeightsResLow);
    expectStabilityResultShape(equalWeightsResHigh);
    expectStabilityResultShape(financeHeavyResLow);
    expectStabilityResultShape(financeHeavyResHigh);

    const diffEqual =
      equalWeightsResHigh.totalScore - equalWeightsResLow.totalScore;
    const diffFinanceHeavy =
      financeHeavyResHigh.totalScore - financeHeavyResLow.totalScore;

    // With finance-heavy weighting, the gap created by good vs bad finances
    // should be at least as large as under equal weights, and ideally larger.
    expect(diffFinanceHeavy).toBeGreaterThanOrEqual(diffEqual);
  });
});

// -----------------------------------------------------------------------------
// 4) Missing or partial dimensions – graceful handling
// -----------------------------------------------------------------------------

describe("HouseholdStabilityCalculator – partial / missing input handling", () => {
  it("handles missing community dimension with safe defaults and notes", () => {
    const partial = {
      ...makeBaselineInput(),
      community: undefined
    };

    const result = calculateHouseholdStability(partial);
    expectStabilityResultShape(result);

    // Should still produce a totalScore
    expect(result.totalScore).toBeGreaterThanOrEqual(0);

    // Radar should still contain community (likely 0 or derived default)
    expect(result.radar).toHaveProperty("community");
    const communityVal = result.radar.community;
    expect(typeof communityVal).toBe("number");
    expect(communityVal).toBeGreaterThanOrEqual(0);
    expect(communityVal).toBeLessThanOrEqual(1);

    // Notes should mention missing or inferred data
    const notesText = result.meta.notes.join(" ").toLowerCase();
    expect(
      notesText.includes("missing") ||
        notesText.includes("default") ||
        notesText.includes("inferred")
    ).toBe(true);
  });

  it("treats clearly catastrophic inputs as significantly low stability", () => {
    const catastrophic = {
      finances: {
        incomeStability: 0.0,
        emergencyFundMonths: 0,
        debtToIncomeRatio: 1.0
      },
      food: {
        storehouseDays: 0,
        gardenReliance: 0,
        preservationCapacity: 0
      },
      housing: {
        tenureSecurity: 0.0,
        repairBacklog: 12,
        disasterRisk: 1.0
      },
      health: {
        insuranceCoverage: 0.0,
        chronicConditionsManaged: 0.0,
        activityLevel: 0.0
      },
      community: {
        mutualAidTier: 0,
        localFamily: 0.0,
        congregation: 0.0
      },
      preparedness: {
        blackoutDaysCovered: 0,
        waterDaysCovered: 0,
        altCooking: 0.0
      }
    };

    const result = calculateHouseholdStability(catastrophic);
    expectStabilityResultShape(result);

    // We don't assume exact thresholds, but totalScore should be low.
    expect(result.totalScore).toBeLessThanOrEqual(30);
  });
});
