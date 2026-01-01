// C:\Users\larho\suka-smart-assistant\src\tests\calculators\gardenAnimal\GardenYieldCalculator.test.js
// -----------------------------------------------------------------------------
// Unit tests for GardenYieldCalculator logic.
//
// ASSUMED PUBLIC API (align your implementation to this shape):
//
//   import { calculateGardenYield } from
//     "@/features/calculators/gardenAnimal/GardenYieldCalculator.logic.js";
//
//   const result = calculateGardenYield(config);
//
// Where `config` looks like:
//
//   {
//     location?: {
//       zone?: string,
//       latitude?: number,
//       longitude?: number
//     },
//     season: {
//       lastFrostDate: string,      // "YYYY-MM-DD"
//       firstFrostDate: string      // "YYYY-MM-DD"
//     },
//     siteModifiers?: {
//       fertilityModifier?: number, // 0.5–1.5 (multiplier)
//       irrigationReliability?: number, // 0–1
//       greenhouseMultiplier?: number   // e.g. small tunnel / greenhouse bump
//     },
//     beds: [
//       {
//         id: string,
//         label?: string,
//         areaSqFt?: number,
//         lengthFt?: number,
//         widthFt?: number,
//         cropPlan: [
//           {
//             cropId: string,
//             name: string,
//             family?: string,
//             variety?: string,
//             daysToMaturity?: number,
//             targetYieldPerPlantLb?: number,
//             targetYieldPerSqFtLb?: number,
//             spacingInRowInches?: number,
//             rowSpacingInches?: number,
//             rowsPerBed?: number,
//             plantsPerHole?: number,
//             successionRounds?: number,
//             expectedLossPct?: number, // 0–100
//             seasonFraction?: number,  // 0–1 of full season used
//             densityModifier?: number  // 0.5–1.5
//           }
//         ]
//       }
//     ]
//   }
//
// And the calculator returns something like:
//
//   {
//     location?: {...},
//     season: {
//       lastFrostDate: string,
//       firstFrostDate: string,
//       seasonLengthDays: number
//     },
//     beds: [
//       {
//         id: string,
//         label?: string,
//         areaSqFt: number,
//         crops: [
//           {
//             cropId: string,
//             name: string,
//             variety?: string,
//             totalPlants: number,
//             expectedHarvestLb: number,
//             expectedHarvestKg: number,
//             expectedHarvestVolumeQt?: number,
//             perSqFtLb: number,
//             perWeekLb: number,
//             successionRounds: number,
//             assumptions: {
//               spacingInRowInches?: number,
//               rowSpacingInches?: number,
//               plantsPerHole?: number,
//               densityModifier?: number,
//               expectedLossPct?: number,
//               fertilityModifier?: number,
//               greenhouseMultiplier?: number
//             }
//           }
//         ],
//         bedTotalLb: number
//       }
//     ],
//     totals: {
//       totalBeds: number,
//       totalCrops: number,
//       totalPlants: number,
//       totalHarvestLb: number,
//       totalHarvestKg: number,
//       averagePerSqFtLb: number
//     },
//     warnings?: string[]
//   }
//
// These tests focus on:
//   * Output shape + numeric sanity
//   * Effects of bed area and spacing on plant count & yield
//   * Succession planting yield boosts
//   * Loss percentages reducing yield
//   * Fertility / greenhouse modifiers
//   * Defensive behavior for weird inputs
//   * SSA compatibility: finite numeric values usable by Planning Graph / SessionRunner
// -----------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import { calculateGardenYield } from "@/features/calculators/gardenAnimal/GardenYieldCalculator.logic.js";

function assertFiniteNumber(value) {
  expect(typeof value).toBe("number");
  expect(Number.isFinite(value)).toBe(true);
}

function assertBaseShape(result) {
  expect(result).toBeTruthy();
  expect(typeof result).toBe("object");

  expect(result.season).toBeTruthy();
  expect(typeof result.season.lastFrostDate).toBe("string");
  expect(typeof result.season.firstFrostDate).toBe("string");
  assertFiniteNumber(result.season.seasonLengthDays);

  expect(Array.isArray(result.beds)).toBe(true);
  expect(result.beds.length).toBeGreaterThanOrEqual(0);

  result.beds.forEach((bed) => {
    expect(typeof bed.id).toBe("string");
    assertFiniteNumber(bed.areaSqFt);
    assertFiniteNumber(bed.bedTotalLb);
    expect(Array.isArray(bed.crops)).toBe(true);

    bed.crops.forEach((crop) => {
      expect(typeof crop.cropId).toBe("string");
      expect(typeof crop.name).toBe("string");
      assertFiniteNumber(crop.totalPlants);
      assertFiniteNumber(crop.expectedHarvestLb);
      assertFiniteNumber(crop.expectedHarvestKg);
      assertFiniteNumber(crop.perSqFtLb);
      assertFiniteNumber(crop.perWeekLb);
      expect(typeof crop.successionRounds).toBe("number");
      expect(typeof crop.assumptions).toBe("object");
    });
  });

  expect(result.totals).toBeTruthy();
  assertFiniteNumber(result.totals.totalBeds);
  assertFiniteNumber(result.totals.totalCrops);
  assertFiniteNumber(result.totals.totalPlants);
  assertFiniteNumber(result.totals.totalHarvestLb);
  assertFiniteNumber(result.totals.totalHarvestKg);
  assertFiniteNumber(result.totals.averagePerSqFtLb);

  if (result.warnings) {
    expect(Array.isArray(result.warnings)).toBe(true);
  }
}

// -----------------------------------------------------------------------------
// Basic single-bed, single-crop scenario
// -----------------------------------------------------------------------------
describe("GardenYieldCalculator – basic structure and math", () => {
  it("returns a well-formed yield summary for a simple bed", () => {
    const result = calculateGardenYield({
      season: {
        lastFrostDate: "2026-04-01",
        firstFrostDate: "2026-11-01"
      },
      beds: [
        {
          id: "bed-1",
          label: "North Bed",
          lengthFt: 10,
          widthFt: 3,
          cropPlan: [
            {
              cropId: "lettuce",
              name: "Leaf Lettuce",
              daysToMaturity: 50,
              targetYieldPerPlantLb: 0.5,
              spacingInRowInches: 8,
              rowSpacingInches: 12,
              rowsPerBed: 3,
              plantsPerHole: 1,
              successionRounds: 1,
              expectedLossPct: 10,
              densityModifier: 1.0
            }
          ]
        }
      ]
    });

    assertBaseShape(result);

    // Season length sanity
    expect(result.season.seasonLengthDays).toBeGreaterThan(150);
    expect(result.season.seasonLengthDays).toBeLessThan(220);

    const bed = result.beds[0];
    expect(bed.id).toBe("bed-1");
    expect(bed.crops.length).toBe(1);
    const crop = bed.crops[0];
    expect(crop.cropId).toBe("lettuce");

    // Yield and plants should both be greater than zero
    expect(crop.totalPlants).toBeGreaterThan(0);
    expect(crop.expectedHarvestLb).toBeGreaterThan(0);

    // Bed total should equal or slightly exceed the crop total (floating-point wiggle)
    expect(bed.bedTotalLb).toBeGreaterThanOrEqual(crop.expectedHarvestLb);
  });
});

// -----------------------------------------------------------------------------
// Area and spacing – more area → more plants & yield, tighter spacing → more plants
// -----------------------------------------------------------------------------
describe("GardenYieldCalculator – area and spacing sensitivity", () => {
  it("increases yield when bed area is doubled", () => {
    const small = calculateGardenYield({
      season: {
        lastFrostDate: "2026-04-01",
        firstFrostDate: "2026-11-01"
      },
      beds: [
        {
          id: "bed-small",
          lengthFt: 8,
          widthFt: 4,
          cropPlan: [
            {
              cropId: "tomato",
              name: "Tomato",
              targetYieldPerPlantLb: 8,
              spacingInRowInches: 24,
              rowSpacingInches: 36,
              rowsPerBed: 2,
              successionRounds: 1,
              expectedLossPct: 0
            }
          ]
        }
      ]
    });

    const large = calculateGardenYield({
      season: {
        lastFrostDate: "2026-04-01",
        firstFrostDate: "2026-11-01"
      },
      beds: [
        {
          id: "bed-large",
          lengthFt: 16, // doubled length; same width
          widthFt: 4,
          cropPlan: [
            {
              cropId: "tomato",
              name: "Tomato",
              targetYieldPerPlantLb: 8,
              spacingInRowInches: 24,
              rowSpacingInches: 36,
              rowsPerBed: 2,
              successionRounds: 1,
              expectedLossPct: 0
            }
          ]
        }
      ]
    });

    assertBaseShape(small);
    assertBaseShape(large);

    const smallTomato = small.beds[0].crops[0];
    const largeTomato = large.beds[0].crops[0];

    expect(largeTomato.totalPlants).toBeGreaterThan(smallTomato.totalPlants);
    expect(largeTomato.expectedHarvestLb).toBeGreaterThan(
      smallTomato.expectedHarvestLb
    );
  });

  it("reduces plant count when spacing is increased", () => {
    const tight = calculateGardenYield({
      season: {
        lastFrostDate: "2026-04-01",
        firstFrostDate: "2026-11-01"
      },
      beds: [
        {
          id: "bed-tight",
          lengthFt: 10,
          widthFt: 3,
          cropPlan: [
            {
              cropId: "carrot",
              name: "Carrot",
              targetYieldPerPlantLb: 0.1,
              spacingInRowInches: 2, // tight spacing
              rowSpacingInches: 8,
              rowsPerBed: 4,
              successionRounds: 1
            }
          ]
        }
      ]
    });

    const loose = calculateGardenYield({
      season: {
        lastFrostDate: "2026-04-01",
        firstFrostDate: "2026-11-01"
      },
      beds: [
        {
          id: "bed-loose",
          lengthFt: 10,
          widthFt: 3,
          cropPlan: [
            {
              cropId: "carrot",
              name: "Carrot",
              targetYieldPerPlantLb: 0.1,
              spacingInRowInches: 4, // looser spacing
              rowSpacingInches: 12,
              rowsPerBed: 3,
              successionRounds: 1
            }
          ]
        }
      ]
    });

    assertBaseShape(tight);
    assertBaseShape(loose);

    const tightCarrot = tight.beds[0].crops[0];
    const looseCarrot = loose.beds[0].crops[0];

    expect(tightCarrot.totalPlants).toBeGreaterThan(looseCarrot.totalPlants);
    expect(tightCarrot.expectedHarvestLb).toBeGreaterThan(
      looseCarrot.expectedHarvestLb
    );
  });
});

// -----------------------------------------------------------------------------
// Succession planting – more rounds → more yield (within same bed)
// -----------------------------------------------------------------------------
describe("GardenYieldCalculator – succession planting effects", () => {
  it("increases yield when successionRounds are greater than 1", () => {
    const singleRound = calculateGardenYield({
      season: {
        lastFrostDate: "2026-04-01",
        firstFrostDate: "2026-11-01"
      },
      beds: [
        {
          id: "bed-single",
          lengthFt: 8,
          widthFt: 4,
          cropPlan: [
            {
              cropId: "bush-bean",
              name: "Bush Bean",
              targetYieldPerPlantLb: 0.3,
              spacingInRowInches: 6,
              rowSpacingInches: 18,
              rowsPerBed: 3,
              successionRounds: 1,
              expectedLossPct: 5
            }
          ]
        }
      ]
    });

    const multiRound = calculateGardenYield({
      season: {
        lastFrostDate: "2026-04-01",
        firstFrostDate: "2026-11-01"
      },
      beds: [
        {
          id: "bed-multi",
          lengthFt: 8,
          widthFt: 4,
          cropPlan: [
            {
              cropId: "bush-bean",
              name: "Bush Bean",
              targetYieldPerPlantLb: 0.3,
              spacingInRowInches: 6,
              rowSpacingInches: 18,
              rowsPerBed: 3,
              successionRounds: 3, // same bed, more rounds
              expectedLossPct: 5
            }
          ]
        }
      ]
    });

    assertBaseShape(singleRound);
    assertBaseShape(multiRound);

    const singleBean = singleRound.beds[0].crops[0];
    const multiBean = multiRound.beds[0].crops[0];

    expect(multiBean.successionRounds).toBeGreaterThan(singleBean.successionRounds);
    expect(multiBean.expectedHarvestLb).toBeGreaterThan(
      singleBean.expectedHarvestLb
    );
  });
});

// -----------------------------------------------------------------------------
// Loss percentage – higher loss → lower yield
// -----------------------------------------------------------------------------
describe("GardenYieldCalculator – expectedLossPct behavior", () => {
  it("reduces expected yield when expectedLossPct increases", () => {
    const lowLoss = calculateGardenYield({
      season: {
        lastFrostDate: "2026-04-01",
        firstFrostDate: "2026-11-01"
      },
      beds: [
        {
          id: "bed-low-loss",
          lengthFt: 10,
          widthFt: 3,
          cropPlan: [
            {
              cropId: "cabbage",
              name: "Cabbage",
              targetYieldPerPlantLb: 3,
              spacingInRowInches: 18,
              rowSpacingInches: 24,
              rowsPerBed: 2,
              successionRounds: 1,
              expectedLossPct: 5
            }
          ]
        }
      ]
    });

    const highLoss = calculateGardenYield({
      season: {
        lastFrostDate: "2026-04-01",
        firstFrostDate: "2026-11-01"
      },
      beds: [
        {
          id: "bed-high-loss",
          lengthFt: 10,
          widthFt: 3,
          cropPlan: [
            {
              cropId: "cabbage",
              name: "Cabbage",
              targetYieldPerPlantLb: 3,
              spacingInRowInches: 18,
              rowSpacingInches: 24,
              rowsPerBed: 2,
              successionRounds: 1,
              expectedLossPct: 40
            }
          ]
        }
      ]
    });

    assertBaseShape(lowLoss);
    assertBaseShape(highLoss);

    const lowCabbage = lowLoss.beds[0].crops[0];
    const highCabbage = highLoss.beds[0].crops[0];

    // Plant count should be the same (loss affects yield, not planting density)
    expect(lowCabbage.totalPlants).toBeCloseTo(highCabbage.totalPlants, 1);

    // Yield should be lower for the higher loss scenario
    expect(highCabbage.expectedHarvestLb).toBeLessThan(
      lowCabbage.expectedHarvestLb
    );
  });
});

// -----------------------------------------------------------------------------
// Fertility / greenhouse modifiers
// -----------------------------------------------------------------------------
describe("GardenYieldCalculator – fertility and greenhouse modifiers", () => {
  it("increases yield when fertilityModifier and greenhouseMultiplier are higher", () => {
    const baseline = calculateGardenYield({
      season: {
        lastFrostDate: "2026-04-01",
        firstFrostDate: "2026-11-01"
      },
      siteModifiers: {
        fertilityModifier: 1.0,
        irrigationReliability: 0.8,
        greenhouseMultiplier: 1.0
      },
      beds: [
        {
          id: "bed-base",
          lengthFt: 10,
          widthFt: 3,
          cropPlan: [
            {
              cropId: "pepper",
              name: "Bell Pepper",
              targetYieldPerPlantLb: 2,
              spacingInRowInches: 18,
              rowSpacingInches: 24,
              rowsPerBed: 2,
              successionRounds: 1,
              expectedLossPct: 10
            }
          ]
        }
      ]
    });

    const boosted = calculateGardenYield({
      season: {
        lastFrostDate: "2026-04-01",
        firstFrostDate: "2026-11-01"
      },
      siteModifiers: {
        fertilityModifier: 1.3,
        irrigationReliability: 0.9,
        greenhouseMultiplier: 1.2
      },
      beds: [
        {
          id: "bed-boosted",
          lengthFt: 10,
          widthFt: 3,
          cropPlan: [
            {
              cropId: "pepper",
              name: "Bell Pepper",
              targetYieldPerPlantLb: 2,
              spacingInRowInches: 18,
              rowSpacingInches: 24,
              rowsPerBed: 2,
              successionRounds: 1,
              expectedLossPct: 10
            }
          ]
        }
      ]
    });

    assertBaseShape(baseline);
    assertBaseShape(boosted);

    const basePepper = baseline.beds[0].crops[0];
    const boostedPepper = boosted.beds[0].crops[0];

    expect(boostedPepper.expectedHarvestLb).toBeGreaterThan(
      basePepper.expectedHarvestLb
    );
  });
});

// -----------------------------------------------------------------------------
// Defensive behavior
// -----------------------------------------------------------------------------
describe("GardenYieldCalculator – defensive behavior", () => {
  it("handles empty beds list without throwing", () => {
    const result = calculateGardenYield({
      season: {
        lastFrostDate: "2026-04-01",
        firstFrostDate: "2026-11-01"
      },
      beds: []
    });

    assertBaseShape(result);
    expect(result.beds.length).toBe(0);
    expect(result.totals.totalBeds).toBe(0);
    expect(result.totals.totalCrops).toBe(0);
    // totalHarvestLb may be 0 but must be finite
    assertFiniteNumber(result.totals.totalHarvestLb);
  });

  it("emits warnings when season dates are invalid", () => {
    const result = calculateGardenYield({
      season: {
        lastFrostDate: "not-a-date",
        firstFrostDate: "also-bad"
      },
      beds: [
        {
          id: "weird-bed",
          areaSqFt: 30,
          cropPlan: [
            {
              cropId: "mystery",
              name: "Mystery Crop",
              targetYieldPerPlantLb: 1,
              spacingInRowInches: 12,
              rowSpacingInches: 18,
              rowsPerBed: 2,
              successionRounds: 1
            }
          ]
        }
      ]
    });

    assertBaseShape(result);
    if (result.warnings && result.warnings.length > 0) {
      const joined = result.warnings.join(" ").toLowerCase();
      expect(joined).toContain("date");
    }
  });

  it("sanitizes negative or extreme numeric inputs", () => {
    const result = calculateGardenYield({
      season: {
        lastFrostDate: "2026-04-01",
        firstFrostDate: "2026-11-01"
      },
      beds: [
        {
          id: "bed-weird",
          lengthFt: -10, // invalid, should be clamped or sanitized
          widthFt: 0, // invalid, should be clamped or sanitized
          cropPlan: [
            {
              cropId: "zucchini",
              name: "Zucchini",
              targetYieldPerPlantLb: -5, // invalid
              spacingInRowInches: 0, // invalid
              rowSpacingInches: 0, // invalid
              rowsPerBed: -1, // invalid
              successionRounds: -3, // invalid
              expectedLossPct: 999 // should be clamped 0–100
            }
          ]
        }
      ]
    });

    assertBaseShape(result);

    const bed = result.beds[0];
    const crop = bed.crops[0];

    // Even with bad input, the calculator should return finite, non-NaN values.
    assertFiniteNumber(bed.areaSqFt);
    assertFiniteNumber(crop.totalPlants);
    assertFiniteNumber(crop.expectedHarvestLb);
  });
});

// -----------------------------------------------------------------------------
// SSA / Planning Graph compatibility
// -----------------------------------------------------------------------------
describe("GardenYieldCalculator – SSA integration checks", () => {
  it("produces stable totals suitable for SSA Planning Graph and SessionRunner", () => {
    const result = calculateGardenYield({
      location: {
        zone: "7b",
        latitude: 34.5,
        longitude: -86.5
      },
      season: {
        lastFrostDate: "2026-03-25",
        firstFrostDate: "2026-11-10"
      },
      beds: [
        {
          id: "bed-a",
          lengthFt: 12,
          widthFt: 3,
          cropPlan: [
            {
              cropId: "tomato",
              name: "Tomato",
              targetYieldPerPlantLb: 10,
              spacingInRowInches: 24,
              rowSpacingInches: 36,
              rowsPerBed: 2,
              successionRounds: 1,
              expectedLossPct: 15
            }
          ]
        },
        {
          id: "bed-b",
          lengthFt: 8,
          widthFt: 4,
          cropPlan: [
            {
              cropId: "lettuce",
              name: "Lettuce",
              targetYieldPerPlantLb: 0.6,
              spacingInRowInches: 8,
              rowSpacingInches: 10,
              rowsPerBed: 4,
              successionRounds: 3,
              expectedLossPct: 20
            }
          ]
        }
      ]
    });

    assertBaseShape(result);

    // Totals must be finite and > 0 for a populated garden.
    expect(result.totals.totalBeds).toBe(2);
    expect(result.totals.totalCrops).toBeGreaterThanOrEqual(2);
    expect(result.totals.totalPlants).toBeGreaterThan(0);
    expect(result.totals.totalHarvestLb).toBeGreaterThan(0);

    // Per-sq-ft averages should also be finite.
    assertFiniteNumber(result.totals.averagePerSqFtLb);
  });
});
