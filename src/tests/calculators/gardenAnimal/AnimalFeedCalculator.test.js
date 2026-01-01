// C:\Users\larho\suka-smart-assistant\src\tests\calculators\gardenAnimal\AnimalFeedCalculator.test.js
// -----------------------------------------------------------------------------
// Unit tests for AnimalFeedCalculator: daily & batch feed requirements.
//
// ASSUMED PUBLIC API:
//
//   import { calculateAnimalFeedPlan } from
//     "@/features/calculators/gardenAnimal/AnimalFeedCalculator.logic.js";
//
//   const plan = calculateAnimalFeedPlan(config);
//
// Where `config` roughly looks like:
//
//   {
//     animals: [
//       {
//         id: string,
//         species: "cow" | "goat" | "sheep" | "chicken" | "duck" | string,
//         breed?: string,
//         ageMonths?: number,
//         weightLb?: number,
//         count: number,
//         lifeStage?: "starter" | "grower" | "finisher" | "layer" | "dry" | "lactating" | "maintenance",
//         productivityLevel?: "low" | "medium" | "high"
//       }
//     ],
//     feedLibrary: [
//       {
//         id: string,
//         label: string,
//         species: string | "all",
//         lifeStage?: string | "all",
//         dryMatterPct: number,    // 0–100
//         crudeProteinPct?: number,
//         meKcalPerKg?: number,
//         costPerLb?: number
//       }
//     ],
//     options?: {
//       timeFrameDays?: number,              // default 1
//       includePasture?: boolean,
//       pastureIntakeLbPerHeadPerDay?: number,
//       roundToBagSizeLb?: number,          // e.g. 50 to round to 50-lb bags
//       targetDMIntakePctBodyWeight?: number // default species-specific
//     }
//   }
//
// And the calculator returns something like:
//
//   {
//     animals: [...resolved animals with implied defaults...],
//     feedPlan: {
//       totalAsFedLb: number,
//       totalDryMatterLb: number,
//       totalCost?: number,
//       perAnimal: [
//         {
//           animalId: string,
//           asFedLbPerDay: number,
//           dryMatterLbPerDay: number,
//           asFedLbForPeriod: number,
//           dryMatterLbForPeriod: number,
//           costPerDay?: number,
//           costForPeriod?: number
//         }
//       ],
//       breakdownByFeed: [
//         {
//           feedId: string,
//           asFedLbTotal: number,
//           dryMatterLbTotal: number,
//           costTotal?: number
//         }
//       ]
//     },
//     params?: {
//       timeFrameDays: number,
//       pastureIntakeLbPerHeadPerDay?: number,
//       roundToBagSizeLb?: number
//     },
//     warnings?: string[]
//   }
//
// Tests focus on:
//   * Output shape & finite numbers
//   * Scaling with animal count & time frame
//   * Heavier / lactating animals needing more feed than maintenance
//   * Bag rounding behavior
//   * Defensive behavior for weird inputs
//   * Stable ranges suitable for SSA Planning Graph & SessionRunner
// -----------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import { calculateAnimalFeedPlan } from "@/features/calculators/gardenAnimal/AnimalFeedCalculator.logic.js";

function assertFiniteNumber(value) {
  expect(typeof value).toBe("number");
  expect(Number.isFinite(value)).toBe(true);
}

function assertFeedPlanShape(plan) {
  expect(plan).toBeTruthy();
  expect(typeof plan).toBe("object");

  expect(plan.feedPlan).toBeTruthy();
  const fp = plan.feedPlan;

  assertFiniteNumber(fp.totalAsFedLb);
  assertFiniteNumber(fp.totalDryMatterLb);
  expect(fp.totalAsFedLb).toBeGreaterThanOrEqual(0);
  expect(fp.totalDryMatterLb).toBeGreaterThanOrEqual(0);

  if (fp.totalCost != null) {
    assertFiniteNumber(fp.totalCost);
    expect(fp.totalCost).toBeGreaterThanOrEqual(0);
  }

  expect(Array.isArray(fp.perAnimal)).toBe(true);
  fp.perAnimal.forEach((row) => {
    expect(typeof row.animalId).toBe("string");
    assertFiniteNumber(row.asFedLbPerDay);
    assertFiniteNumber(row.dryMatterLbPerDay);
    assertFiniteNumber(row.asFedLbForPeriod);
    assertFiniteNumber(row.dryMatterLbForPeriod);

    expect(row.asFedLbPerDay).toBeGreaterThanOrEqual(0);
    expect(row.dryMatterLbPerDay).toBeGreaterThanOrEqual(0);
    expect(row.asFedLbForPeriod).toBeGreaterThanOrEqual(0);
    expect(row.dryMatterLbForPeriod).toBeGreaterThanOrEqual(0);

    if (row.costPerDay != null) {
      assertFiniteNumber(row.costPerDay);
      expect(row.costPerDay).toBeGreaterThanOrEqual(0);
    }
    if (row.costForPeriod != null) {
      assertFiniteNumber(row.costForPeriod);
      expect(row.costForPeriod).toBeGreaterThanOrEqual(0);
    }
  });

  expect(Array.isArray(fp.breakdownByFeed)).toBe(true);
  fp.breakdownByFeed.forEach((row) => {
    expect(typeof row.feedId).toBe("string");
    assertFiniteNumber(row.asFedLbTotal);
    assertFiniteNumber(row.dryMatterLbTotal);
    expect(row.asFedLbTotal).toBeGreaterThanOrEqual(0);
    expect(row.dryMatterLbTotal).toBeGreaterThanOrEqual(0);

    if (row.costTotal != null) {
      assertFiniteNumber(row.costTotal);
      expect(row.costTotal).toBeGreaterThanOrEqual(0);
    }
  });

  if (plan.params) {
    assertFiniteNumber(plan.params.timeFrameDays);
    expect(plan.params.timeFrameDays).toBeGreaterThan(0);
    if (plan.params.pastureIntakeLbPerHeadPerDay != null) {
      assertFiniteNumber(plan.params.pastureIntakeLbPerHeadPerDay);
    }
    if (plan.params.roundToBagSizeLb != null) {
      assertFiniteNumber(plan.params.roundToBagSizeLb);
    }
  }

  if (plan.warnings) {
    expect(Array.isArray(plan.warnings)).toBe(true);
  }
}

// -----------------------------------------------------------------------------
// BASIC – single animal, 1-day plan
// -----------------------------------------------------------------------------
describe("AnimalFeedCalculator – basic single-animal plan", () => {
  it("produces a valid plan for a single goat over one day", () => {
    const plan = calculateAnimalFeedPlan({
      animals: [
        {
          id: "goat-1",
          species: "goat",
          breed: "Nubian",
          ageMonths: 18,
          weightLb: 120,
          count: 1,
          lifeStage: "maintenance",
          productivityLevel: "medium"
        }
      ],
      feedLibrary: [
        {
          id: "goat-pellet",
          label: "Goat Maintenance Pellet",
          species: "goat",
          lifeStage: "maintenance",
          dryMatterPct: 90,
          crudeProteinPct: 16,
          costPerLb: 0.45
        }
      ],
      options: {
        timeFrameDays: 1,
        targetDMIntakePctBodyWeight: 3, // % BW as DM
        includePasture: false,
        clampToZero: true
      }
    });

    assertFeedPlanShape(plan);

    // 3% of 120 lb = 3.6 lb DM, as-fed ~ 4 lb (with 90% DM) ballpark.
    const fp = plan.feedPlan;
    expect(fp.totalDryMatterLb).toBeGreaterThan(2);
    expect(fp.totalDryMatterLb).toBeLessThan(6);

    const goatRow = fp.perAnimal.find((row) => row.animalId === "goat-1");
    expect(goatRow).toBeTruthy();
    expect(goatRow.asFedLbPerDay).toBeGreaterThan(2.5);
    expect(goatRow.asFedLbPerDay).toBeLessThan(7);
  });
});

// -----------------------------------------------------------------------------
// SCALING WITH ANIMAL COUNT
// -----------------------------------------------------------------------------
describe("AnimalFeedCalculator – scales with animal count", () => {
  it("increases feed requirements with more animals", () => {
    const baseAnimal = {
      id: "ewe-group",
      species: "sheep",
      breed: "Katahdin",
      ageMonths: 24,
      weightLb: 150,
      lifeStage: "maintenance",
      productivityLevel: "medium"
    };

    const config = {
      feedLibrary: [
        {
          id: "sheep-mix",
          label: "Sheep Maintenance Mix",
          species: "sheep",
          lifeStage: "maintenance",
          dryMatterPct: 88,
          crudeProteinPct: 14,
          costPerLb: 0.35
        }
      ],
      options: {
        timeFrameDays: 7, // 1 week
        targetDMIntakePctBodyWeight: 2.5,
        includePasture: false
      }
    };

    const plan5 = calculateAnimalFeedPlan({
      animals: [{ ...baseAnimal, count: 5 }],
      ...config
    });

    const plan10 = calculateAnimalFeedPlan({
      animals: [{ ...baseAnimal, count: 10 }],
      ...config
    });

    assertFeedPlanShape(plan5);
    assertFeedPlanShape(plan10);

    // Doubling count should ~ double feed requirement.
    expect(plan10.feedPlan.totalAsFedLb).toBeGreaterThan(plan5.feedPlan.totalAsFedLb);
    const ratio =
      plan10.feedPlan.totalAsFedLb / plan5.feedPlan.totalAsFedLb;
    expect(ratio).toBeGreaterThan(1.7);
    expect(ratio).toBeLessThan(2.3);
  });
});

// -----------------------------------------------------------------------------
// LIFE STAGE / PRODUCTIVITY – lactating vs maintenance
// -----------------------------------------------------------------------------
describe("AnimalFeedCalculator – life stage and productivity", () => {
  it("assigns more feed to high-producing lactating cow than dry cow", () => {
    const feedLibrary = [
      {
        id: "dairy-ration",
        label: "Dairy Cow Lactation Ration",
        species: "cow",
        lifeStage: "lactating",
        dryMatterPct: 88,
        crudeProteinPct: 18,
        costPerLb: 0.20
      },
      {
        id: "cow-maintenance",
        label: "Cow Maintenance Ration",
        species: "cow",
        lifeStage: "maintenance",
        dryMatterPct: 88,
        crudeProteinPct: 12,
        costPerLb: 0.15
      }
    ];

    const baseWeight = 1300;

    const lactatingPlan = calculateAnimalFeedPlan({
      animals: [
        {
          id: "cow-lactating",
          species: "cow",
          breed: "Jersey",
          ageMonths: 48,
          weightLb: baseWeight,
          count: 1,
          lifeStage: "lactating",
          productivityLevel: "high"
        }
      ],
      feedLibrary,
      options: {
        timeFrameDays: 1,
        targetDMIntakePctBodyWeight: 4, // heavy intake for dairy
        includePasture: false
      }
    });

    const dryPlan = calculateAnimalFeedPlan({
      animals: [
        {
          id: "cow-dry",
          species: "cow",
          breed: "Jersey",
          ageMonths: 48,
          weightLb: baseWeight,
          count: 1,
          lifeStage: "dry",
          productivityLevel: "low"
        }
      ],
      feedLibrary,
      options: {
        timeFrameDays: 1,
        targetDMIntakePctBodyWeight: 2.25,
        includePasture: false
      }
    });

    assertFeedPlanShape(lactatingPlan);
    assertFeedPlanShape(dryPlan);

    expect(
      lactatingPlan.feedPlan.totalDryMatterLb
    ).toBeGreaterThan(dryPlan.feedPlan.totalDryMatterLb);

    // Cost should generally be higher for lactating animal as well.
    if (
      lactatingPlan.feedPlan.totalCost != null &&
      dryPlan.feedPlan.totalCost != null
    ) {
      expect(
        lactatingPlan.feedPlan.totalCost
      ).toBeGreaterThan(dryPlan.feedPlan.totalCost);
    }
  });
});

// -----------------------------------------------------------------------------
// TIMEFRAME & BAG ROUNDING
// -----------------------------------------------------------------------------
describe("AnimalFeedCalculator – timeframe and bag rounding", () => {
  it("scales by timeFrameDays and rounds to bag size when requested", () => {
    const plan = calculateAnimalFeedPlan({
      animals: [
        {
          id: "meat-chicks",
          species: "chicken",
          breed: "Cornish Cross",
          ageMonths: 1,
          weightLb: 1.5,
          count: 25,
          lifeStage: "grower",
          productivityLevel: "high"
        }
      ],
      feedLibrary: [
        {
          id: "broiler-grower",
          label: "Broiler Grower",
          species: "chicken",
          lifeStage: "grower",
          dryMatterPct: 89,
          crudeProteinPct: 20,
          costPerLb: 0.32
        }
      ],
      options: {
        timeFrameDays: 21, // 3-week grow period
        targetDMIntakePctBodyWeight: 10, // small birds, high % BW
        roundToBagSizeLb: 50,
        includePasture: false
      }
    });

    assertFeedPlanShape(plan);

    const total = plan.feedPlan.totalAsFedLb;
    // With rounding, totalAsFedLb should be a multiple of bag size.
    const remainder = total % 50;
    expect(remainder).toBeLessThan(1e-6); // allow floating noise

    // Should be significantly larger than per-day requirement.
    const perAnimal = plan.feedPlan.perAnimal[0];
    expect(perAnimal.asFedLbForPeriod).toBeGreaterThan(
      perAnimal.asFedLbPerDay * 5
    );
  });
});

// -----------------------------------------------------------------------------
// PASTURE INTAKE – reduces concentrate requirement
// -----------------------------------------------------------------------------
describe("AnimalFeedCalculator – pasture intake reduces concentrates", () => {
  it("reduces concentrate feed when pasture intake is available", () => {
    const baseAnimals = [
      {
        id: "ewes-on-pasture",
        species: "sheep",
        breed: "Dorper",
        ageMonths: 36,
        weightLb: 150,
        count: 10,
        lifeStage: "maintenance",
        productivityLevel: "medium"
      }
    ];

    const feedLibrary = [
      {
        id: "sheep-concentrate",
        label: "Sheep Concentrate",
        species: "sheep",
        lifeStage: "maintenance",
        dryMatterPct: 90,
        crudeProteinPct: 16,
        costPerLb: 0.40
      }
    ];

    const noPasture = calculateAnimalFeedPlan({
      animals: baseAnimals,
      feedLibrary,
      options: {
        timeFrameDays: 7,
        targetDMIntakePctBodyWeight: 2.5,
        includePasture: false
      }
    });

    const withPasture = calculateAnimalFeedPlan({
      animals: baseAnimals,
      feedLibrary,
      options: {
        timeFrameDays: 7,
        targetDMIntakePctBodyWeight: 2.5,
        includePasture: true,
        pastureIntakeLbPerHeadPerDay: 3
      }
    });

    assertFeedPlanShape(noPasture);
    assertFeedPlanShape(withPasture);

    // Concentrate as-fed total should be lower when pasture is available.
    expect(withPasture.feedPlan.totalAsFedLb).toBeLessThan(
      noPasture.feedPlan.totalAsFedLb
    );
  });
});

// -----------------------------------------------------------------------------
// DEFENSIVE – weird / invalid inputs
// -----------------------------------------------------------------------------
describe("AnimalFeedCalculator – defensive behavior", () => {
  it("handles invalid numbers gracefully without NaNs", () => {
    const plan = calculateAnimalFeedPlan({
      animals: [
        {
          id: "invalid-animal",
          species: "",
          breed: "???",
          ageMonths: -5,
          weightLb: -100,
          count: -10,
          lifeStage: "unknown",
          productivityLevel: "extreme"
        }
      ],
      feedLibrary: [
        {
          id: "invalid-feed",
          label: "??? feed",
          species: "all",
          lifeStage: "all",
          dryMatterPct: 999,
          crudeProteinPct: -20,
          costPerLb: -1
        }
      ],
      options: {
        timeFrameDays: -30,
        targetDMIntakePctBodyWeight: -3,
        includePasture: true,
        pastureIntakeLbPerHeadPerDay: -5,
        roundToBagSizeLb: -50
      }
    });

    assertFeedPlanShape(plan);

    // Ensure no NaNs, negatives clamped, and some warnings exist.
    expect(plan.feedPlan.totalAsFedLb).toBeGreaterThanOrEqual(0);
    expect(plan.feedPlan.totalDryMatterLb).toBeGreaterThanOrEqual(0);
    if (plan.feedPlan.totalCost != null) {
      expect(plan.feedPlan.totalCost).toBeGreaterThanOrEqual(0);
    }

    plan.feedPlan.perAnimal.forEach((row) => {
      expect(row.asFedLbPerDay).toBeGreaterThanOrEqual(0);
      expect(row.dryMatterLbPerDay).toBeGreaterThanOrEqual(0);
      expect(row.asFedLbForPeriod).toBeGreaterThanOrEqual(0);
      expect(row.dryMatterLbForPeriod).toBeGreaterThanOrEqual(0);
    });

    if (plan.warnings && plan.warnings.length > 0) {
      const joined = plan.warnings.join(" ").toLowerCase();
      expect(
        joined.includes("invalid") ||
          joined.includes("clamped") ||
          joined.includes("out of range")
      ).toBe(true);
    }
  });
});

// -----------------------------------------------------------------------------
// SSA INTEGRATION – stable ranges for Planning Graph
// -----------------------------------------------------------------------------
describe("AnimalFeedCalculator – SSA integration sanity checks", () => {
  it("returns stable, reasonable feed volumes for mixed-species homestead", () => {
    const plan = calculateAnimalFeedPlan({
      animals: [
        {
          id: "dairy-goats",
          species: "goat",
          breed: "Alpine",
          ageMonths: 36,
          weightLb: 140,
          count: 5,
          lifeStage: "lactating",
          productivityLevel: "high"
        },
        {
          id: "layer-hens",
          species: "chicken",
          breed: "ISA Brown",
          ageMonths: 18,
          weightLb: 4.5,
          count: 20,
          lifeStage: "layer",
          productivityLevel: "high"
        }
      ],
      feedLibrary: [
        {
          id: "goat-lactation",
          label: "Goat Lactation Mix",
          species: "goat",
          lifeStage: "lactating",
          dryMatterPct: 89,
          crudeProteinPct: 18,
          costPerLb: 0.45
        },
        {
          id: "layer-ration",
          label: "Layer Ration",
          species: "chicken",
          lifeStage: "layer",
          dryMatterPct: 89,
          crudeProteinPct: 17,
          costPerLb: 0.35
        }
      ],
      options: {
        timeFrameDays: 30,
        targetDMIntakePctBodyWeight: 4, // for goats; calculator may override per species
        includePasture: true,
        pastureIntakeLbPerHeadPerDay: 2,
        roundToBagSizeLb: 50
      }
    });

    assertFeedPlanShape(plan);

    const total = plan.feedPlan.totalAsFedLb;
    expect(total).toBeGreaterThan(200); // at least several hundred lbs for 30 days
    expect(total).toBeLessThan(4000); // sanity upper bound for planner

    // Bag rounding check when enabled.
    const remainder = total % 50;
    expect(remainder).toBeLessThan(1e-6);
  });
});
