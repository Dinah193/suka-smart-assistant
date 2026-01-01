// C:\Users\larho\suka-smart-assistant\src\tests\calculators\gardenAnimal\IrrigationCalculator.test.js
// -----------------------------------------------------------------------------
// Unit tests for IrrigationCalculator logic: schedules & water volume.
//
// ASSUMED PUBLIC API:
//
//   import { calculateIrrigationPlan } from
//     "@/features/calculators/gardenAnimal/IrrigationCalculator.logic.js";
//
//   const result = calculateIrrigationPlan(config);
//
// Where `config` looks like:
//
//   {
//     location?: {
//       zone?: string,
//       latitude?: number,
//       longitude?: number
//     },
//     bed: {
//       id: string,
//       label?: string,
//       areaSqFt?: number,
//       lengthFt?: number,
//       widthFt?: number
//     },
//     crop: {
//       group: "leafy" | "root" | "fruiting" | "legume" | "perennial" | "lawn",
//       rootDepthIn?: number,           // e.g. 6–24 in
//       stage?: "seedling" | "veg" | "flowering" | "fruiting" | "dormant"
//     },
//     soil: {
//       textureClass: "sand" | "loam" | "clay" | "sandy-loam" | "clay-loam",
//       infiltrationInPerHr?: number,   // usable if provided
//       availableWaterInPerIn?: number, // avail. water per inch of root depth
//       mulchDepthIn?: number           // 0–4+ inches
//     },
//     climate: {
//       etoInPerDay?: number,           // baseline ET0 in/day for period
//       recentRainInLast7Days?: number,
//       forecastRainInNext7Days?: number
//     },
//     system: {
//       type: "drip" | "sprinkler" | "soaker" | "flood",
//       applicationRateInPerHr?: number,  // in/hr
//       distributionUniformity?: number,  // 0–1
//       maxRuntimeMinutesPerEvent?: number
//     },
//     goals?: {
//       targetDepletionFraction?: number, // 0.3–0.6 typical
//       maxEventsPerWeek?: number,
//       waterConservationMode?: boolean,  // prefer less frequent, deeper
//       startDayOffset?: number,          // days from "today"
//       planningHorizonDays?: number      // default 7–14
//     }
//   }
//
// And the calculator returns something like:
//
//   {
//     bed: { id: string, label?: string, areaSqFt: number },
//     crop: { group: string, rootDepthIn: number, stage: string },
//     soil: { textureClass: string, availableWaterInPerIn: number, ... },
//     climate: { etoInPerDay: number, recentRainInLast7Days: number, forecastRainInNext7Days: number },
//     system: { type: string, applicationRateInPerHr: number, distributionUniformity: number },
//     goals: { ...resolved goals... },
//     summary: {
//       totalIrrigationInPerWeek: number,
//       totalIrrigationGallonsPerWeek: number,
//       effectiveRainInPerWeek: number,
//       effectiveWaterInPerWeek: number, // irrigation + effective rain
//       averageEventsPerWeek: number
//     },
//     schedule: [
//       {
//         id: string,
//         dayOffset: number,                // 0..planningHorizonDays-1
//         label: string,
//         runtimeMinutes: number,
//         depthIn: number,                  // depth of water applied
//         gallons: number,
//         targetDepletionFraction: number
//       }
//     ],
//     warnings?: string[]
//   }
//
// These tests focus on:
//   * Basic schedule shape + numeric sanity
//   * Drip vs sprinkler behavior (runtime differences)
//   * Response to rainfall (reduced irrigation)
//   * Water conservation mode (fewer, deeper events)
//   * Defensive handling of bad/missing inputs
//   * Stable, finite outputs for SSA Planning Graph & SessionRunner
// -----------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import { calculateIrrigationPlan } from "@/features/calculators/gardenAnimal/IrrigationCalculator.logic.js";

function assertFiniteNumber(value) {
  expect(typeof value).toBe("number");
  expect(Number.isFinite(value)).toBe(true);
}

function assertPlanShape(plan) {
  expect(plan).toBeTruthy();
  expect(typeof plan).toBe("object");

  // bed
  expect(plan.bed).toBeTruthy();
  expect(typeof plan.bed.id).toBe("string");
  assertFiniteNumber(plan.bed.areaSqFt);

  // crop
  expect(plan.crop).toBeTruthy();
  expect(typeof plan.crop.group).toBe("string");
  assertFiniteNumber(plan.crop.rootDepthIn);
  expect(typeof plan.crop.stage).toBe("string");

  // soil
  expect(plan.soil).toBeTruthy();
  expect(typeof plan.soil.textureClass).toBe("string");
  assertFiniteNumber(plan.soil.availableWaterInPerIn);

  // climate
  expect(plan.climate).toBeTruthy();
  assertFiniteNumber(plan.climate.etoInPerDay);
  assertFiniteNumber(plan.climate.recentRainInLast7Days);
  assertFiniteNumber(plan.climate.forecastRainInNext7Days);

  // system
  expect(plan.system).toBeTruthy();
  expect(["drip", "sprinkler", "soaker", "flood"]).toContain(plan.system.type);
  assertFiniteNumber(plan.system.applicationRateInPerHr);
  assertFiniteNumber(plan.system.distributionUniformity);

  // goals
  expect(plan.goals).toBeTruthy();

  // summary
  expect(plan.summary).toBeTruthy();
  assertFiniteNumber(plan.summary.totalIrrigationInPerWeek);
  assertFiniteNumber(plan.summary.totalIrrigationGallonsPerWeek);
  assertFiniteNumber(plan.summary.effectiveRainInPerWeek);
  assertFiniteNumber(plan.summary.effectiveWaterInPerWeek);
  assertFiniteNumber(plan.summary.averageEventsPerWeek);

  // schedule
  expect(Array.isArray(plan.schedule)).toBe(true);

  plan.schedule.forEach((event) => {
    expect(typeof event.id).toBe("string");
    expect(typeof event.label).toBe("string");
    assertFiniteNumber(event.dayOffset);
    assertFiniteNumber(event.runtimeMinutes);
    assertFiniteNumber(event.depthIn);
    assertFiniteNumber(event.gallons);
    assertFiniteNumber(event.targetDepletionFraction);

    expect(event.runtimeMinutes).toBeGreaterThanOrEqual(0);
    expect(event.depthIn).toBeGreaterThanOrEqual(0);
    expect(event.gallons).toBeGreaterThanOrEqual(0);
  });

  if (plan.warnings) {
    expect(Array.isArray(plan.warnings)).toBe(true);
  }
}

// -----------------------------------------------------------------------------
// BASIC DRIP SCHEDULE
// -----------------------------------------------------------------------------
describe("IrrigationCalculator – basic drip schedule", () => {
  it("produces a sensible weekly drip schedule for a leafy bed in loam soil", () => {
    const plan = calculateIrrigationPlan({
      location: {
        zone: "7b",
        latitude: 34.5,
        longitude: -86.5
      },
      bed: {
        id: "bed-drip-1",
        label: "Kitchen Greens",
        lengthFt: 10,
        widthFt: 4
      },
      crop: {
        group: "leafy",
        rootDepthIn: 8,
        stage: "veg"
      },
      soil: {
        textureClass: "loam",
        availableWaterInPerIn: 0.18,
        mulchDepthIn: 2
      },
      climate: {
        etoInPerDay: 0.2,
        recentRainInLast7Days: 0.1,
        forecastRainInNext7Days: 0.2
      },
      system: {
        type: "drip",
        applicationRateInPerHr: 0.4,
        distributionUniformity: 0.85,
        maxRuntimeMinutesPerEvent: 60
      },
      goals: {
        targetDepletionFraction: 0.4,
        maxEventsPerWeek: 4,
        waterConservationMode: false,
        planningHorizonDays: 7
      }
    });

    assertPlanShape(plan);

    // Should have at least one irrigation event
    expect(plan.schedule.length).toBeGreaterThan(0);

    // Drip systems tend to use moderate runtimes with shallower depths.
    const avgRuntime =
      plan.schedule.reduce((sum, e) => sum + e.runtimeMinutes, 0) /
      plan.schedule.length;
    expect(avgRuntime).toBeGreaterThan(5);
    expect(avgRuntime).toBeLessThanOrEqual(60);

    // Weekly irrigation depth in a reasonable range for leafy greens in mild ET0
    expect(plan.summary.totalIrrigationInPerWeek).toBeGreaterThan(0.2);
    expect(plan.summary.totalIrrigationInPerWeek).toBeLessThan(2.0);
  });
});

// -----------------------------------------------------------------------------
// SPRINKLER VS DRIP – runtime differences
// -----------------------------------------------------------------------------
describe("IrrigationCalculator – drip vs sprinkler behavior", () => {
  it("uses longer runtimes for low-rate drip vs faster sprinklers for the same depth", () => {
    const baseConfig = {
      location: { zone: "7b" },
      bed: {
        id: "bed-compare",
        areaSqFt: 100
      },
      crop: {
        group: "fruiting",
        rootDepthIn: 12,
        stage: "fruiting"
      },
      soil: {
        textureClass: "loam",
        availableWaterInPerIn: 0.18,
        mulchDepthIn: 1.5
      },
      climate: {
        etoInPerDay: 0.25,
        recentRainInLast7Days: 0.2,
        forecastRainInNext7Days: 0
      },
      goals: {
        targetDepletionFraction: 0.5,
        maxEventsPerWeek: 3,
        planningHorizonDays: 7
      }
    };

    const dripPlan = calculateIrrigationPlan({
      ...baseConfig,
      system: {
        type: "drip",
        applicationRateInPerHr: 0.25,
        distributionUniformity: 0.85,
        maxRuntimeMinutesPerEvent: 90
      }
    });

    const sprinklerPlan = calculateIrrigationPlan({
      ...baseConfig,
      system: {
        type: "sprinkler",
        applicationRateInPerHr: 1.0,
        distributionUniformity: 0.75,
        maxRuntimeMinutesPerEvent: 45
      }
    });

    assertPlanShape(dripPlan);
    assertPlanShape(sprinklerPlan);

    const dripAvgRuntime =
      dripPlan.schedule.reduce((sum, e) => sum + e.runtimeMinutes, 0) /
      Math.max(dripPlan.schedule.length, 1);
    const sprinklerAvgRuntime =
      sprinklerPlan.schedule.reduce((sum, e) => sum + e.runtimeMinutes, 0) /
      Math.max(sprinklerPlan.schedule.length, 1);

    // For similar depths, drip should generally run longer than sprinkler.
    expect(dripAvgRuntime).toBeGreaterThan(sprinklerAvgRuntime);
  });
});

// -----------------------------------------------------------------------------
// RAINFALL ADJUSTMENT
// -----------------------------------------------------------------------------
describe("IrrigationCalculator – rainfall reduction", () => {
  it("reduces irrigation when recent and forecast rainfall are high", () => {
    const dryPlan = calculateIrrigationPlan({
      bed: {
        id: "bed-dry",
        lengthFt: 20,
        widthFt: 4
      },
      crop: {
        group: "leafy",
        rootDepthIn: 8,
        stage: "veg"
      },
      soil: {
        textureClass: "loam",
        availableWaterInPerIn: 0.18
      },
      climate: {
        etoInPerDay: 0.25,
        recentRainInLast7Days: 0,
        forecastRainInNext7Days: 0
      },
      system: {
        type: "drip",
        applicationRateInPerHr: 0.4,
        distributionUniformity: 0.85,
        maxRuntimeMinutesPerEvent: 60
      },
      goals: {
        targetDepletionFraction: 0.4,
        planningHorizonDays: 7
      }
    });

    const wetPlan = calculateIrrigationPlan({
      bed: {
        id: "bed-wet",
        lengthFt: 20,
        widthFt: 4
      },
      crop: {
        group: "leafy",
        rootDepthIn: 8,
        stage: "veg"
      },
      soil: {
        textureClass: "loam",
        availableWaterInPerIn: 0.18
      },
      climate: {
        etoInPerDay: 0.25,
        recentRainInLast7Days: 1.5,
        forecastRainInNext7Days: 1.0
      },
      system: {
        type: "drip",
        applicationRateInPerHr: 0.4,
        distributionUniformity: 0.85,
        maxRuntimeMinutesPerEvent: 60
      },
      goals: {
        targetDepletionFraction: 0.4,
        planningHorizonDays: 7
      }
    });

    assertPlanShape(dryPlan);
    assertPlanShape(wetPlan);

    // Irrigation depth should be lower when rainfall is high.
    expect(wetPlan.summary.totalIrrigationInPerWeek).toBeLessThan(
      dryPlan.summary.totalIrrigationInPerWeek
    );
  });
});

// -----------------------------------------------------------------------------
// WATER CONSERVATION MODE – fewer, deeper events
// -----------------------------------------------------------------------------
describe("IrrigationCalculator – water conservation mode", () => {
  it("prefers fewer, deeper events when waterConservationMode is true", () => {
    const normalPlan = calculateIrrigationPlan({
      bed: {
        id: "bed-normal",
        areaSqFt: 80
      },
      crop: {
        group: "root",
        rootDepthIn: 10,
        stage: "veg"
      },
      soil: {
        textureClass: "sandy-loam",
        availableWaterInPerIn: 0.12
      },
      climate: {
        etoInPerDay: 0.2,
        recentRainInLast7Days: 0.1,
        forecastRainInNext7Days: 0.1
      },
      system: {
        type: "drip",
        applicationRateInPerHr: 0.35,
        distributionUniformity: 0.8,
        maxRuntimeMinutesPerEvent: 60
      },
      goals: {
        targetDepletionFraction: 0.4,
        maxEventsPerWeek: 5,
        waterConservationMode: false,
        planningHorizonDays: 7
      }
    });

    const conservationPlan = calculateIrrigationPlan({
      bed: {
        id: "bed-conserve",
        areaSqFt: 80
      },
      crop: {
        group: "root",
        rootDepthIn: 10,
        stage: "veg"
      },
      soil: {
        textureClass: "sandy-loam",
        availableWaterInPerIn: 0.12
      },
      climate: {
        etoInPerDay: 0.2,
        recentRainInLast7Days: 0.1,
        forecastRainInNext7Days: 0.1
      },
      system: {
        type: "drip",
        applicationRateInPerHr: 0.35,
        distributionUniformity: 0.8,
        maxRuntimeMinutesPerEvent: 60
      },
      goals: {
        targetDepletionFraction: 0.5,
        maxEventsPerWeek: 3,
        waterConservationMode: true,
        planningHorizonDays: 7
      }
    });

    assertPlanShape(normalPlan);
    assertPlanShape(conservationPlan);

    // Conservation mode should have fewer or equal events.
    expect(conservationPlan.schedule.length).toBeLessThanOrEqual(
      normalPlan.schedule.length
    );

    // But the average depth per event should be greater or equal.
    const avgDepthNormal =
      normalPlan.schedule.reduce((sum, e) => sum + e.depthIn, 0) /
      Math.max(normalPlan.schedule.length, 1);
    const avgDepthConserve =
      conservationPlan.schedule.reduce((sum, e) => sum + e.depthIn, 0) /
      Math.max(conservationPlan.schedule.length, 1);

    expect(avgDepthConserve).toBeGreaterThanOrEqual(avgDepthNormal);
  });
});

// -----------------------------------------------------------------------------
// DEFENSIVE BEHAVIOR – invalid/missing inputs
// -----------------------------------------------------------------------------
describe("IrrigationCalculator – defensive behavior", () => {
  it("handles missing/invalid values without NaNs or negative water", () => {
    const plan = calculateIrrigationPlan({
      bed: {
        id: "bed-weird",
        lengthFt: -10, // invalid
        widthFt: 0 // invalid
      },
      crop: {
        group: "leafy",
        rootDepthIn: -5, // invalid
        stage: "veg"
      },
      soil: {
        textureClass: "sand",
        availableWaterInPerIn: -0.5, // invalid
        mulchDepthIn: -1 // invalid
      },
      climate: {
        etoInPerDay: -0.3, // invalid
        recentRainInLast7Days: NaN,
        forecastRainInNext7Days: 999999
      },
      system: {
        type: "drip",
        applicationRateInPerHr: -0.5, // invalid
        distributionUniformity: 2, // invalid
        maxRuntimeMinutesPerEvent: -10 // invalid
      },
      goals: {
        targetDepletionFraction: -0.5, // invalid
        maxEventsPerWeek: -1, // invalid
        waterConservationMode: true,
        planningHorizonDays: -7 // invalid
      }
    });

    assertPlanShape(plan);

    // Schedule events should never have negative runtime or gallons.
    plan.schedule.forEach((event) => {
      expect(event.runtimeMinutes).toBeGreaterThanOrEqual(0);
      expect(event.gallons).toBeGreaterThanOrEqual(0);
      expect(event.depthIn).toBeGreaterThanOrEqual(0);
    });

    // Summary values must be finite and non-negative.
    expect(plan.summary.totalIrrigationInPerWeek).toBeGreaterThanOrEqual(0);
    expect(plan.summary.totalIrrigationGallonsPerWeek).toBeGreaterThanOrEqual(
      0
    );

    if (plan.warnings && plan.warnings.length > 0) {
      const lower = plan.warnings.join(" ").toLowerCase();
      expect(
        lower.includes("invalid") ||
          lower.includes("clamped") ||
          lower.includes("out of range")
      ).toBe(true);
    }
  });
});

// -----------------------------------------------------------------------------
// SSA INTEGRATION – stable numbers for Planning Graph & SessionRunner
// -----------------------------------------------------------------------------
describe("IrrigationCalculator – SSA integration checks", () => {
  it("returns stable, finite, area-aware values usable by Planning Graph and SessionRunner", () => {
    const plan = calculateIrrigationPlan({
      location: {
        zone: "8a",
        latitude: 32.5,
        longitude: -96.8
      },
      bed: {
        id: "ssa-irrigation-bed",
        label: "SSA Main Bed",
        lengthFt: 16,
        widthFt: 4
      },
      crop: {
        group: "mixed",
        rootDepthIn: 12,
        stage: "veg"
      },
      soil: {
        textureClass: "clay-loam",
        availableWaterInPerIn: 0.2,
        mulchDepthIn: 2
      },
      climate: {
        etoInPerDay: 0.23,
        recentRainInLast7Days: 0.3,
        forecastRainInNext7Days: 0.5
      },
      system: {
        type: "drip",
        applicationRateInPerHr: 0.3,
        distributionUniformity: 0.85,
        maxRuntimeMinutesPerEvent: 75
      },
      goals: {
        targetDepletionFraction: 0.45,
        maxEventsPerWeek: 4,
        waterConservationMode: true,
        startDayOffset: 0,
        planningHorizonDays: 10
      }
    });

    assertPlanShape(plan);

    // Area-aware: more area should mean more gallons for similar depths.
    expect(plan.bed.areaSqFt).toBeGreaterThan(0);
    expect(plan.summary.totalIrrigationGallonsPerWeek).toBeGreaterThan(0);

    // Day offsets should be within horizon.
    const maxDayOffset = plan.schedule.reduce(
      (max, e) => Math.max(max, e.dayOffset),
      0
    );
    expect(maxDayOffset).toBeLessThanOrEqual(10);

    // No event should exceed max runtime constraint.
    plan.schedule.forEach((event) => {
      expect(event.runtimeMinutes).toBeLessThanOrEqual(
        plan.system.maxRuntimeMinutesPerEvent ||
          plan.system.maxRuntimeMinutesPerEvent === 0
          ? plan.system.maxRuntimeMinutesPerEvent
          : 9999
      );
    });
  });
});
