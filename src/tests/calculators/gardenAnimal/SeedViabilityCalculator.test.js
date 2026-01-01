// C:\Users\larho\suka-smart-assistant\src\tests\calculators\gardenAnimal\SeedViabilityCalculator.test.js
// -----------------------------------------------------------------------------
// Unit tests for SeedViabilityCalculator: seed viability & sow-extra estimates.
//
// ASSUMED PUBLIC API:
//
//   import { calculateSeedViability } from
//     "@/features/calculators/gardenAnimal/SeedViabilityCalculator.logic.js";
//
//   const result = calculateSeedViability(config);
//
// Where `config` roughly looks like:
//
//   {
//     lot: {
//       id: string,
//       label?: string,
//       species: string,
//       variety?: string,
//       packetSizeSeeds?: number,
//       baselineGerminationPct?: number, // e.g. 95
//       yearOfProduction?: number,
//       expectedShelfLifeYears?: number
//     },
//     storage: {
//       avgTempF?: number,        // average storage temperature
//       avgHumidityPct?: number,  // average RH
//       darkness?: boolean,       // true if stored in dark
//       sealed?: boolean,         // sealed container
//       desiccant?: boolean       // with desiccant
//     },
//     env: {
//       currentYear: number
//     },
//     options?: {
//       targetGerminationPct?: number,   // e.g. 85
//       conservativeMode?: boolean,      // add extra safety margin
//       clampToZero?: boolean            // never return negative viability
//     }
//   }
//
// And the calculator returns something like:
//
//   {
//     lot: { ...resolved lot metadata... },
//     storage: { ...resolved storage metadata... },
//     env: { currentYear: number },
//     params: {
//       baselineGerminationPct: number,
//       yearsSinceProduction: number,
//       expectedShelfLifeYears: number,
//       storageQualityIndex: number,      // 0–1
//       decayRatePerYear: number          // 0–1
//     },
//     result: {
//       estimatedViabilityPctNow: number, // 0–100
//       recommendedSowExtraPct: number,   // 0–e.g. 300
//       effectiveGerminationPct: number,  // after sow extra logic
//       classification: "fresh" | "ok" | "aging" | "borderline" | "dead",
//       warnings?: string[]
//     },
//     timeline?: Array<{
//       year: number,
//       estimatedViabilityPct: number
//     }>
//   }
//
// These tests focus on:
//   * Basic shape & finite numbers
//   * Older lots having lower viability than fresh ones
//   * Good vs poor storage impact
//   * Conservative mode adding extra sow percentage
//   * Clamp-to-zero behavior (no negative viability)
//   * Defensive handling of bogus inputs
//   * Stable outputs for SSA Planning Graph & SessionRunner
// -----------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import { calculateSeedViability } from "@/features/calculators/gardenAnimal/SeedViabilityCalculator.logic.js";

function assertFiniteNumber(value) {
  expect(typeof value).toBe("number");
  expect(Number.isFinite(value)).toBe(true);
}

function assertResultShape(plan) {
  expect(plan).toBeTruthy();
  expect(typeof plan).toBe("object");

  // lot
  expect(plan.lot).toBeTruthy();
  expect(typeof plan.lot.id).toBe("string");
  expect(typeof plan.lot.species).toBe("string");

  // env
  expect(plan.env).toBeTruthy();
  assertFiniteNumber(plan.env.currentYear);

  // params
  expect(plan.params).toBeTruthy();
  assertFiniteNumber(plan.params.baselineGerminationPct);
  assertFiniteNumber(plan.params.yearsSinceProduction);
  assertFiniteNumber(plan.params.expectedShelfLifeYears);
  assertFiniteNumber(plan.params.storageQualityIndex);
  assertFiniteNumber(plan.params.decayRatePerYear);

  // result
  expect(plan.result).toBeTruthy();
  assertFiniteNumber(plan.result.estimatedViabilityPctNow);
  assertFiniteNumber(plan.result.recommendedSowExtraPct);
  assertFiniteNumber(plan.result.effectiveGerminationPct);
  expect(typeof plan.result.classification).toBe("string");

  // Reasonable ranges
  expect(plan.result.estimatedViabilityPctNow).toBeGreaterThanOrEqual(0);
  expect(plan.result.estimatedViabilityPctNow).toBeLessThanOrEqual(100);
  expect(plan.result.effectiveGerminationPct).toBeGreaterThanOrEqual(0);
  expect(plan.result.effectiveGerminationPct).toBeLessThanOrEqual(100);
  expect(plan.params.storageQualityIndex).toBeGreaterThanOrEqual(0);
  expect(plan.params.storageQualityIndex).toBeLessThanOrEqual(1);

  if (plan.result.warnings) {
    expect(Array.isArray(plan.result.warnings)).toBe(true);
  }

  if (plan.timeline) {
    expect(Array.isArray(plan.timeline)).toBe(true);
    plan.timeline.forEach((pt) => {
      assertFiniteNumber(pt.year);
      assertFiniteNumber(pt.estimatedViabilityPct);
    });
  }
}

// -----------------------------------------------------------------------------
// BASIC FRESH LOT – near baseline viability
// -----------------------------------------------------------------------------
describe("SeedViabilityCalculator – basic fresh lot", () => {
  it("keeps a recent seed lot close to baseline germination", () => {
    const plan = calculateSeedViability({
      lot: {
        id: "seed-fresh-1",
        species: "Tomato",
        variety: "Roma",
        packetSizeSeeds: 100,
        baselineGerminationPct: 95,
        yearOfProduction: 2024,
        expectedShelfLifeYears: 6
      },
      storage: {
        avgTempF: 60,
        avgHumidityPct: 35,
        darkness: true,
        sealed: true,
        desiccant: true
      },
      env: {
        currentYear: 2025
      },
      options: {
        targetGerminationPct: 90,
        conservativeMode: false,
        clampToZero: true
      }
    });

    assertResultShape(plan);

    // Only one season old, good storage – viability should be high.
    expect(plan.params.yearsSinceProduction).toBeCloseTo(1, 1);
    expect(plan.result.estimatedViabilityPctNow).toBeGreaterThan(80);
    expect(plan.result.estimatedViabilityPctNow).toBeLessThanOrEqual(100);

    // Recommended sow extra should be modest for fresh seeds.
    expect(plan.result.recommendedSowExtraPct).toBeLessThanOrEqual(40);
  });
});

// -----------------------------------------------------------------------------
// AGE EFFECT – old lot vs fresh lot
// -----------------------------------------------------------------------------
describe("SeedViabilityCalculator – age reduces viability", () => {
  it("yields lower viability for much older seed lots", () => {
    const baseLot = {
      species: "Carrot",
      variety: "Nantes",
      packetSizeSeeds: 500,
      baselineGerminationPct: 90,
      expectedShelfLifeYears: 3
    };

    const storage = {
      avgTempF: 65,
      avgHumidityPct: 40,
      darkness: true,
      sealed: true,
      desiccant: false
    };

    const freshPlan = calculateSeedViability({
      lot: {
        ...baseLot,
        id: "carrot-fresh",
        yearOfProduction: 2023
      },
      storage,
      env: {
        currentYear: 2025
      },
      options: {
        targetGerminationPct: 85,
        clampToZero: true
      }
    });

    const oldPlan = calculateSeedViability({
      lot: {
        ...baseLot,
        id: "carrot-old",
        yearOfProduction: 2018
      },
      storage,
      env: {
        currentYear: 2025
      },
      options: {
        targetGerminationPct: 85,
        clampToZero: true
      }
    });

    assertResultShape(freshPlan);
    assertResultShape(oldPlan);

    expect(oldPlan.params.yearsSinceProduction).toBeGreaterThan(
      freshPlan.params.yearsSinceProduction
    );

    // Older lot should have substantially lower viability.
    expect(oldPlan.result.estimatedViabilityPctNow).toBeLessThan(
      freshPlan.result.estimatedViabilityPctNow
    );

    // Old lot should also require a much higher sow extra percentage.
    expect(oldPlan.result.recommendedSowExtraPct).toBeGreaterThan(
      freshPlan.result.recommendedSowExtraPct
    );
  });
});

// -----------------------------------------------------------------------------
// STORAGE QUALITY IMPACT – good vs poor storage
// -----------------------------------------------------------------------------
describe("SeedViabilityCalculator – storage quality impact", () => {
  it("reduces viability when storage conditions are poor", () => {
    const baseConfig = {
      lot: {
        id: "bean-lot",
        species: "Bush Bean",
        variety: "Provider",
        packetSizeSeeds: 200,
        baselineGerminationPct: 95,
        yearOfProduction: 2021,
        expectedShelfLifeYears: 4
      },
      env: {
        currentYear: 2025
      },
      options: {
        targetGerminationPct: 90,
        clampToZero: true
      }
    };

    const goodStoragePlan = calculateSeedViability({
      ...baseConfig,
      storage: {
        avgTempF: 55,
        avgHumidityPct: 30,
        darkness: true,
        sealed: true,
        desiccant: true
      }
    });

    const poorStoragePlan = calculateSeedViability({
      ...baseConfig,
      storage: {
        avgTempF: 80,
        avgHumidityPct: 70,
        darkness: false,
        sealed: false,
        desiccant: false
      }
    });

    assertResultShape(goodStoragePlan);
    assertResultShape(poorStoragePlan);

    expect(goodStoragePlan.params.storageQualityIndex).toBeGreaterThan(
      poorStoragePlan.params.storageQualityIndex
    );

    expect(poorStoragePlan.result.estimatedViabilityPctNow).toBeLessThan(
      goodStoragePlan.result.estimatedViabilityPctNow
    );
  });
});

// -----------------------------------------------------------------------------
// CONSERVATIVE MODE – extra cushion
// -----------------------------------------------------------------------------
describe("SeedViabilityCalculator – conservative mode", () => {
  it("recommends more extra seed when conservativeMode is true", () => {
    const base = {
      lot: {
        id: "lettuce-conservative",
        species: "Lettuce",
        variety: "Butterhead",
        packetSizeSeeds: 300,
        baselineGerminationPct: 92,
        yearOfProduction: 2022,
        expectedShelfLifeYears: 4
      },
      storage: {
        avgTempF: 60,
        avgHumidityPct: 40,
        darkness: true,
        sealed: true,
        desiccant: false
      },
      env: {
        currentYear: 2025
      }
    };

    const normalPlan = calculateSeedViability({
      ...base,
      options: {
        targetGerminationPct: 85,
        conservativeMode: false,
        clampToZero: true
      }
    });

    const conservativePlan = calculateSeedViability({
      ...base,
      options: {
        targetGerminationPct: 85,
        conservativeMode: true,
        clampToZero: true
      }
    });

    assertResultShape(normalPlan);
    assertResultShape(conservativePlan);

    expect(conservativePlan.result.recommendedSowExtraPct).toBeGreaterThanOrEqual(
      normalPlan.result.recommendedSowExtraPct
    );
  });
});

// -----------------------------------------------------------------------------
// CLAMP-TO-ZERO – no negative viability
// -----------------------------------------------------------------------------
describe("SeedViabilityCalculator – clamp-to-zero behavior", () => {
  it("never returns negative viability and flags dead seeds", () => {
    const plan = calculateSeedViability({
      lot: {
        id: "onion-ancient",
        species: "Onion",
        variety: "Yellow Storage",
        packetSizeSeeds: 100,
        baselineGerminationPct: 90,
        yearOfProduction: 2005,
        expectedShelfLifeYears: 2
      },
      storage: {
        avgTempF: 80,
        avgHumidityPct: 75,
        darkness: false,
        sealed: false,
        desiccant: false
      },
      env: {
        currentYear: 2025
      },
      options: {
        targetGerminationPct: 80,
        clampToZero: true
      }
    });

    assertResultShape(plan);

    expect(plan.result.estimatedViabilityPctNow).toBeGreaterThanOrEqual(0);
    expect(plan.result.estimatedViabilityPctNow).toBeLessThanOrEqual(100);

    // Very old seeds for short-lived species should be essentially dead.
    expect(plan.result.estimatedViabilityPctNow).toBeLessThanOrEqual(10);
    expect(plan.result.classification.toLowerCase()).toBe("dead");

    if (plan.result.warnings && plan.result.warnings.length > 0) {
      const joined = plan.result.warnings.join(" ").toLowerCase();
      expect(
        joined.includes("expired") ||
          joined.includes("non-viable") ||
          joined.includes("dead")
      ).toBe(true);
    }
  });
});

// -----------------------------------------------------------------------------
// DEFENSIVE BEHAVIOR – weird inputs
// -----------------------------------------------------------------------------
describe("SeedViabilityCalculator – defensive behavior", () => {
  it("handles invalid inputs without NaNs and provides warnings", () => {
    const plan = calculateSeedViability({
      lot: {
        id: "weird-lot",
        species: "", // missing species name
        variety: "Unknown",
        packetSizeSeeds: -100, // invalid
        baselineGerminationPct: 150, // invalid
        yearOfProduction: 3000, // impossible future
        expectedShelfLifeYears: -5 // invalid
      },
      storage: {
        avgTempF: -10, // invalid
        avgHumidityPct: 200, // invalid
        darkness: null,
        sealed: null,
        desiccant: null
      },
      env: {
        currentYear: 1900 // far before production year
      },
      options: {
        targetGerminationPct: 200, // invalid
        conservativeMode: true,
        clampToZero: true
      }
    });

    assertResultShape(plan);

    // Ensure nothing blew up into NaNs or crazy negatives.
    expect(plan.result.estimatedViabilityPctNow).toBeGreaterThanOrEqual(0);
    expect(plan.result.estimatedViabilityPctNow).toBeLessThanOrEqual(100);
    expect(plan.result.effectiveGerminationPct).toBeGreaterThanOrEqual(0);
    expect(plan.result.effectiveGerminationPct).toBeLessThanOrEqual(100);
    expect(plan.params.yearsSinceProduction).toBeGreaterThanOrEqual(0);

    if (plan.result.warnings && plan.result.warnings.length > 0) {
      const joined = plan.result.warnings.join(" ").toLowerCase();
      expect(
        joined.includes("invalid") ||
          joined.includes("clamped") ||
          joined.includes("out of range") ||
          joined.includes("year")
      ).toBe(true);
    }
  });
});

// -----------------------------------------------------------------------------
// SSA INTEGRATION – stable timeline & values
// -----------------------------------------------------------------------------
describe("SeedViabilityCalculator – SSA integration checks", () => {
  it("returns a stable timeline that Planning Graph can use for storehouse forecasting", () => {
    const plan = calculateSeedViability({
      lot: {
        id: "ssa-seed-lot",
        species: "Pea",
        variety: "Sugar Snap",
        packetSizeSeeds: 150,
        baselineGerminationPct: 95,
        yearOfProduction: 2022,
        expectedShelfLifeYears: 5
      },
      storage: {
        avgTempF: 58,
        avgHumidityPct: 38,
        darkness: true,
        sealed: true,
        desiccant: true
      },
      env: {
        currentYear: 2025
      },
      options: {
        targetGerminationPct: 90,
        conservativeMode: true,
        clampToZero: true
      }
    });

    assertResultShape(plan);

    // Timeline should project at least a few years.
    if (plan.timeline && plan.timeline.length > 0) {
      const minYear = plan.timeline.reduce(
        (min, pt) => Math.min(min, pt.year),
        Infinity
      );
      const maxYear = plan.timeline.reduce(
        (max, pt) => Math.max(max, pt.year),
        -Infinity
      );

      expect(minYear).toBeLessThanOrEqual(plan.env.currentYear);
      expect(maxYear).toBeGreaterThanOrEqual(plan.env.currentYear);

      // Viability should decrease or remain flat over time, not increase wildly.
      for (let i = 1; i < plan.timeline.length; i += 1) {
        const prev = plan.timeline[i - 1].estimatedViabilityPct;
        const curr = plan.timeline[i].estimatedViabilityPct;

        // Allow small numeric wiggles, but not huge jumps upward.
        expect(curr).toBeLessThanOrEqual(prev + 5);
      }
    }
  });
});
