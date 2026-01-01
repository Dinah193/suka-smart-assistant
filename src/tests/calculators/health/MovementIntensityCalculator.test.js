// C:\Users\larho\suka-smart-assistant\src\tests\calculators\health\MovementIntensityCalculator.test.js
// -----------------------------------------------------------------------------
// Unit tests for MovementIntensityCalculator logic.
//
// Assumed MovementIntensityCalculator.logic.js public API:
//
//   export function calculateMovementIntensity(profile)
//
// Where `profile` looks like (extend as needed in your implementation):
//   {
//     sex: "female" | "male",
//     ageYears: number,
//     weightKg: number,
//     heightCm?: number,
//     baselineActivity?: "sedentary" | "light" | "moderate" | "active" | "athlete",
//     goal?: "maintain" | "fatLoss" | "fitness" | "athlete",
//     sessionsPerWeek?: number,
//     avgSessionMinutes?: number
//   }
//
// And `calculateMovementIntensity(profile)` returns an object like:
//
//   {
//     weeklyCalories: number,      // total estimated calories burned per week from planned movement
//     perSessionCalories: number,  // calories burned per session
//     metValue: number,            // approximate METs of planned intensity
//     intensityLabel: string,      // "light", "moderate", "vigorous", etc.
//     recommendedMinutes: number,  // recommended weekly minutes at target intensity
//     method?: string,             // e.g. "movement-intensity-v1"
//     notes?: string
//   }
//
// These tests focus on shape, relationships, and sanity ranges so the actual
// formula can be refined without breaking SSA integration.
// -----------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import { calculateMovementIntensity } from "@/features/calculators/health/MovementIntensityCalculator.logic.js";

// Canonical baseline profiles
const BASE_FEMALE_70KG = Object.freeze({
  sex: "female",
  ageYears: 35,
  weightKg: 70,
  heightCm: 165,
  baselineActivity: "moderate",
  goal: "maintain",
  sessionsPerWeek: 3,
  avgSessionMinutes: 40
});

const BASE_MALE_85KG = Object.freeze({
  sex: "male",
  ageYears: 35,
  weightKg: 85,
  heightCm: 178,
  baselineActivity: "moderate",
  goal: "maintain",
  sessionsPerWeek: 3,
  avgSessionMinutes: 40
});

describe("MovementIntensityCalculator.calculateMovementIntensity – basic shape", () => {
  it("returns a result object with expected fields for a valid profile", () => {
    const result = calculateMovementIntensity(BASE_FEMALE_70KG);

    expect(result).toBeTruthy();
    expect(typeof result).toBe("object");

    expect(typeof result.weeklyCalories).toBe("number");
    expect(typeof result.perSessionCalories).toBe("number");
    expect(typeof result.metValue).toBe("number");
    expect(typeof result.intensityLabel).toBe("string");
    expect(typeof result.recommendedMinutes).toBe("number");

    // Sanity ranges
    expect(result.weeklyCalories).toBeGreaterThan(50);
    expect(result.weeklyCalories).toBeLessThan(15000);

    expect(result.perSessionCalories).toBeGreaterThan(10);
    expect(result.perSessionCalories).toBeLessThan(result.weeklyCalories + 1);

    expect(result.metValue).toBeGreaterThan(1);   // > resting
    expect(result.metValue).toBeLessThan(20);     // < extreme MET value

    expect(result.recommendedMinutes).toBeGreaterThanOrEqual(0);
    expect(result.recommendedMinutes).toBeLessThan(2000); // < ~33h/week at target intensity

    if (result.method) {
      expect(typeof result.method).toBe("string");
    }
    if (result.notes) {
      expect(typeof result.notes).toBe("string");
    }
  });

  it("keeps weeklyCalories consistent with perSessionCalories * sessionsPerWeek within tolerance", () => {
    const profile = { ...BASE_FEMALE_70KG, sessionsPerWeek: 4, avgSessionMinutes: 30 };
    const result = calculateMovementIntensity(profile);

    const idealWeekly = result.perSessionCalories * (profile.sessionsPerWeek || 0);
    const diff = Math.abs(result.weeklyCalories - idealWeekly);

    // Allow some rounding/error tolerance
    expect(diff).toBeLessThan(idealWeekly * 0.25 + 0.0001);
  });
});

describe("MovementIntensityCalculator.calculateMovementIntensity – weight, duration, and sessions", () => {
  it("increases calories with higher body weight (same settings)", () => {
    const light = calculateMovementIntensity({ ...BASE_FEMALE_70KG, weightKg: 50 });
    const medium = calculateMovementIntensity({ ...BASE_FEMALE_70KG, weightKg: 70 });
    const heavy = calculateMovementIntensity({ ...BASE_FEMALE_70KG, weightKg: 90 });

    expect(medium.perSessionCalories).toBeGreaterThan(light.perSessionCalories);
    expect(heavy.perSessionCalories).toBeGreaterThan(medium.perSessionCalories);
  });

  it("increases calories with longer session duration (same weight/sessionsPerWeek)", () => {
    const shortSession = calculateMovementIntensity({
      ...BASE_FEMALE_70KG,
      avgSessionMinutes: 20
    });
    const longSession = calculateMovementIntensity({
      ...BASE_FEMALE_70KG,
      avgSessionMinutes: 60
    });

    expect(longSession.perSessionCalories).toBeGreaterThan(shortSession.perSessionCalories);
    expect(longSession.weeklyCalories).toBeGreaterThan(shortSession.weeklyCalories);
  });

  it("increases weekly calories with more sessions per week (same per-session timing)", () => {
    const twoSessions = calculateMovementIntensity({
      ...BASE_FEMALE_70KG,
      sessionsPerWeek: 2
    });
    const fiveSessions = calculateMovementIntensity({
      ...BASE_FEMALE_70KG,
      sessionsPerWeek: 5
    });

    expect(fiveSessions.weeklyCalories).toBeGreaterThan(twoSessions.weeklyCalories);
  });

  it("gives higher weekly calories for heavier male vs lighter female with same pattern", () => {
    const female = calculateMovementIntensity(BASE_FEMALE_70KG);
    const male = calculateMovementIntensity(BASE_MALE_85KG);

    expect(male.weeklyCalories).toBeGreaterThan(female.weeklyCalories);
  });
});

describe("MovementIntensityCalculator.calculateMovementIntensity – baseline activity and goals", () => {
  it("uses lower recommendedMinutes for maintain vs fatLoss for same baseline activity", () => {
    const maintain = calculateMovementIntensity({
      ...BASE_FEMALE_70KG,
      goal: "maintain"
    });

    const fatLoss = calculateMovementIntensity({
      ...BASE_FEMALE_70KG,
      goal: "fatLoss"
    });

    expect(fatLoss.recommendedMinutes).toBeGreaterThanOrEqual(maintain.recommendedMinutes);
  });

  it("increases target intensity and minutes for fitness/athlete goals vs maintain", () => {
    const maintain = calculateMovementIntensity({
      ...BASE_FEMALE_70KG,
      goal: "maintain"
    });

    const fitness = calculateMovementIntensity({
      ...BASE_FEMALE_70KG,
      goal: "fitness"
    });

    const athlete = calculateMovementIntensity({
      ...BASE_FEMALE_70KG,
      goal: "athlete"
    });

    expect(fitness.metValue).toBeGreaterThanOrEqual(maintain.metValue);
    expect(athlete.metValue).toBeGreaterThanOrEqual(fitness.metValue);

    expect(fitness.recommendedMinutes).toBeGreaterThanOrEqual(maintain.recommendedMinutes);
    expect(athlete.recommendedMinutes).toBeGreaterThanOrEqual(fitness.recommendedMinutes);
  });

  it("applies higher recommendedMinutes for sedentary baseline vs active baseline for same goal", () => {
    const sedentary = calculateMovementIntensity({
      ...BASE_FEMALE_70KG,
      baselineActivity: "sedentary",
      goal: "fitness"
    });

    const active = calculateMovementIntensity({
      ...BASE_FEMALE_70KG,
      baselineActivity: "active",
      goal: "fitness"
    });

    // Sedentary user should need more planned minutes than someone already active
    expect(sedentary.recommendedMinutes).toBeGreaterThanOrEqual(active.recommendedMinutes);
  });

  it("defaults to a reasonable baselineActivity and goal when omitted", () => {
    const explicit = calculateMovementIntensity({
      ...BASE_FEMALE_70KG,
      baselineActivity: "moderate",
      goal: "maintain"
    });

    const implicit = calculateMovementIntensity({
      ...BASE_FEMALE_70KG,
      baselineActivity: undefined,
      goal: undefined
    });

    const diff = Math.abs(explicit.recommendedMinutes - implicit.recommendedMinutes);
    expect(diff).toBeLessThan(explicit.recommendedMinutes * 0.2 + 0.0001);
  });
});

describe("MovementIntensityCalculator.calculateMovementIntensity – intensityLabel mapping", () => {
  it("maps lower METs to 'light' or similar label", () => {
    const result = calculateMovementIntensity({
      ...BASE_FEMALE_70KG,
      goal: "maintain",
      baselineActivity: "light",
      // encourage lower-intensity prescription
      sessionsPerWeek: 2,
      avgSessionMinutes: 20
    });

    expect(result.metValue).toBeGreaterThan(1);
    expect(result.metValue).toBeLessThan(4.5);
    expect(result.intensityLabel.toLowerCase()).toMatch(/light|low/);
  });

  it("maps higher METs to 'vigorous' or similar label", () => {
    const result = calculateMovementIntensity({
      ...BASE_FEMALE_70KG,
      goal: "athlete",
      baselineActivity: "active",
      sessionsPerWeek: 6,
      avgSessionMinutes: 60
    });

    expect(result.metValue).toBeGreaterThanOrEqual(6);
    expect(result.intensityLabel.toLowerCase()).toMatch(/vigorous|high|intense/);
  });
});

describe("MovementIntensityCalculator.calculateMovementIntensity – safety and guardrails", () => {
  it("keeps weekly minutes and calories within broad safe bounds", () => {
    const extreme = calculateMovementIntensity({
      sex: "male",
      ageYears: 30,
      weightKg: 120,
      heightCm: 190,
      baselineActivity: "athlete",
      goal: "athlete",
      sessionsPerWeek: 12,
      avgSessionMinutes: 120
    });

    // Hard safety ceilings – to catch runaway formulas
    expect(extreme.recommendedMinutes).toBeLessThan(3000); // < 50h/week at prescribed intensity
    expect(extreme.weeklyCalories).toBeLessThan(60000);    // high but below extreme outliers
  });

  it("throws or gracefully returns non-valid result for clearly invalid input", () => {
    const badProfiles = [
      { sex: "female", ageYears: -1, weightKg: 60 },
      { sex: "male", ageYears: 0, weightKg: 80 },
      { sex: "female", ageYears: 30, weightKg: -10 },
      { sex: "male", ageYears: 40, weightKg: 0 }
    ];

    badProfiles.forEach((profile) => {
      let threw = false;
      let result = undefined;

      try {
        result = calculateMovementIntensity(profile);
      } catch (err) {
        threw = true;
      }

      if (!threw) {
        const looksValid =
          result &&
          typeof result === "object" &&
          typeof result.weeklyCalories === "number" &&
          result.weeklyCalories > 0;

        expect(looksValid).toBe(false);
      }
    });
  });

  it("degrades gracefully when sessionsPerWeek or avgSessionMinutes are missing or invalid", () => {
    const missingSessions = calculateMovementIntensity({
      ...BASE_FEMALE_70KG,
      sessionsPerWeek: undefined
    });

    const missingDuration = calculateMovementIntensity({
      ...BASE_FEMALE_70KG,
      avgSessionMinutes: undefined
    });

    expect(missingSessions).toBeTruthy();
    expect(typeof missingSessions.weeklyCalories).toBe("number");
    expect(missingSessions.weeklyCalories).toBeGreaterThanOrEqual(0);

    expect(missingDuration).toBeTruthy();
    expect(typeof missingDuration.weeklyCalories).toBe("number");
    expect(missingDuration.weeklyCalories).toBeGreaterThanOrEqual(0);
  });
});
