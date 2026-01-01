// C:\Users\larho\suka-smart-assistant\src\tests\calculators\health\HairProteinCalculator.test.js
// -----------------------------------------------------------------------------
// Unit tests for HairProteinCalculator logic.
//
// Assumed HairProteinCalculator.logic.js public API:
//
//   export function calculateHairProteinNeeds(profile)
//
// Where `profile` looks like (extend as needed in your implementation):
//   {
//     sex: "female" | "male",
//     ageYears: number,
//     weightKg: number,
//     heightCm?: number,
//     activityLevel?: "sedentary" | "light" | "moderate" | "active" | "athlete",
//     hairGoal?: "maintain" | "protect" | "regrow" | "repair",
//     hairDamageLevel?: "low" | "medium" | "high",
//     mealsPerDay?: number
//   }
//
// And `calculateHairProteinNeeds(profile)` returns an object like:
//
//   {
//     dailyGrams: number,      // total daily grams of protein recommended for hair
//     perMealGrams: number,    // recommended grams per meal for hair support
//     range?: { min: number, max: number }, // optional safe range
//     method?: string,         // e.g. "hair-protein-v1"
//     notes?: string
//   }
//
// These tests focus on *relationships* and sanity ranges so the calculator
// is free to use your preferred formula, as long as it behaves consistently.
//
// If your actual logic file uses slightly different names, either:
//   - Update your logic to match this API, OR
//   - Adjust these tests accordingly.
// -----------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import { calculateHairProteinNeeds } from "@/features/calculators/health/HairProteinCalculator.logic.js";

// Canonical profiles for comparison
const BASE_FEMALE_70KG = Object.freeze({
  sex: "female",
  ageYears: 35,
  weightKg: 70,
  heightCm: 165,
  activityLevel: "moderate",
  hairGoal: "maintain",
  hairDamageLevel: "low",
  mealsPerDay: 3
});

const BASE_MALE_85KG = Object.freeze({
  sex: "male",
  ageYears: 35,
  weightKg: 85,
  heightCm: 178,
  activityLevel: "moderate",
  hairGoal: "maintain",
  hairDamageLevel: "low",
  mealsPerDay: 3
});

describe("HairProteinCalculator.calculateHairProteinNeeds – basic shape", () => {
  it("returns a result object with dailyGrams and perMealGrams for a valid profile", () => {
    const result = calculateHairProteinNeeds(BASE_FEMALE_70KG);

    expect(result).toBeTruthy();
    expect(typeof result).toBe("object");

    expect(typeof result.dailyGrams).toBe("number");
    expect(typeof result.perMealGrams).toBe("number");

    // Sanity ranges so values are reasonable:
    // - daily grams in a plausible physiological range
    expect(result.dailyGrams).toBeGreaterThan(20);
    expect(result.dailyGrams).toBeLessThan(300);

    // - per-meal grams should be lower than the daily total
    expect(result.perMealGrams).toBeGreaterThan(5);
    expect(result.perMealGrams).toBeLessThan(result.dailyGrams);

    if (result.range) {
      expect(typeof result.range.min).toBe("number");
      expect(typeof result.range.max).toBe("number");
      expect(result.range.min).toBeLessThan(result.range.max);
    }

    if (result.method) {
      expect(typeof result.method).toBe("string");
    }
    if (result.notes) {
      expect(typeof result.notes).toBe("string");
    }
  });

  it("roughly aligns perMealGrams with dailyGrams / mealsPerDay when mealsPerDay is provided", () => {
    const profile = { ...BASE_FEMALE_70KG, mealsPerDay: 4 };
    const result = calculateHairProteinNeeds(profile);

    // Expect per-meal grams to be within ±20% of a simple equal split
    const ideal = result.dailyGrams / profile.mealsPerDay;
    const diff = Math.abs(result.perMealGrams - ideal);

    expect(diff).toBeLessThan(ideal * 0.2 + 0.0001);
  });
});

describe("HairProteinCalculator.calculateHairProteinNeeds – goal and damage relationships", () => {
  it("increases daily protein when hairGoal is regrow vs maintain", () => {
    const maintain = calculateHairProteinNeeds({
      ...BASE_FEMALE_70KG,
      hairGoal: "maintain"
    });

    const regrow = calculateHairProteinNeeds({
      ...BASE_FEMALE_70KG,
      hairGoal: "regrow"
    });

    expect(regrow.dailyGrams).toBeGreaterThan(maintain.dailyGrams);
  });

  it("increases daily protein when hairGoal is repair vs protect", () => {
    const protect = calculateHairProteinNeeds({
      ...BASE_FEMALE_70KG,
      hairGoal: "protect"
    });

    const repair = calculateHairProteinNeeds({
      ...BASE_FEMALE_70KG,
      hairGoal: "repair"
    });

    expect(repair.dailyGrams).toBeGreaterThanOrEqual(protect.dailyGrams);
  });

  it("increases protein for higher hairDamageLevel (high vs low)", () => {
    const lowDamage = calculateHairProteinNeeds({
      ...BASE_FEMALE_70KG,
      hairDamageLevel: "low"
    });

    const highDamage = calculateHairProteinNeeds({
      ...BASE_FEMALE_70KG,
      hairDamageLevel: "high"
    });

    expect(highDamage.dailyGrams).toBeGreaterThan(lowDamage.dailyGrams);
  });

  it("uses a sensible default hairGoal if omitted (treated as maintain)", () => {
    const explicitMaintain = calculateHairProteinNeeds({
      ...BASE_FEMALE_70KG,
      hairGoal: "maintain"
    });

    const implicitMaintain = calculateHairProteinNeeds({
      ...BASE_FEMALE_70KG,
      hairGoal: undefined
    });

    // They don't have to be identical, but should be very close
    const diff = Math.abs(explicitMaintain.dailyGrams - implicitMaintain.dailyGrams);
    expect(diff).toBeLessThan(explicitMaintain.dailyGrams * 0.05 + 0.0001);
  });
});

describe("HairProteinCalculator.calculateHairProteinNeeds – body size and activity", () => {
  it("scales protein up for higher body weight (same goal, same activity)", () => {
    const light = calculateHairProteinNeeds({
      ...BASE_FEMALE_70KG,
      weightKg: 50
    });
    const medium = calculateHairProteinNeeds({
      ...BASE_FEMALE_70KG,
      weightKg: 70
    });
    const heavy = calculateHairProteinNeeds({
      ...BASE_FEMALE_70KG,
      weightKg: 90
    });

    expect(medium.dailyGrams).toBeGreaterThan(light.dailyGrams);
    expect(heavy.dailyGrams).toBeGreaterThan(medium.dailyGrams);
  });

  it("increases protein for more active profiles (active vs sedentary)", () => {
    const sedentary = calculateHairProteinNeeds({
      ...BASE_FEMALE_70KG,
      activityLevel: "sedentary"
    });

    const active = calculateHairProteinNeeds({
      ...BASE_FEMALE_70KG,
      activityLevel: "active"
    });

    expect(active.dailyGrams).toBeGreaterThan(sedentary.dailyGrams);
  });

  it("gives higher absolute gram values for heavier male vs lighter female (same goal/activity)", () => {
    const female = calculateHairProteinNeeds(BASE_FEMALE_70KG);
    const male = calculateHairProteinNeeds(BASE_MALE_85KG);

    expect(male.dailyGrams).toBeGreaterThan(female.dailyGrams);
  });
});

describe("HairProteinCalculator.calculateHairProteinNeeds – safety and guardrails", () => {
  it("keeps protein within an upper safe bound for typical adults", () => {
    // An extreme-but-valid scenario: heavy athlete with regrow + high damage
    const extreme = calculateHairProteinNeeds({
      sex: "male",
      ageYears: 30,
      weightKg: 120,
      heightCm: 190,
      activityLevel: "athlete",
      hairGoal: "regrow",
      hairDamageLevel: "high",
      mealsPerDay: 4
    });

    // For hair-specific protein, > 250g/day would usually be excessive.
    // We assert a generous upper limit to catch runaway formulas.
    expect(extreme.dailyGrams).toBeLessThan(260);
  });

  it("rejects or gracefully handles clearly invalid input", () => {
    const badProfiles = [
      { sex: "female", ageYears: -1, weightKg: 60 },
      { sex: "male", ageYears: 30, weightKg: 0 },
      { sex: "female", ageYears: 30, weightKg: -5 },
      { sex: "male", ageYears: 0, weightKg: 70 }
    ];

    badProfiles.forEach((profile) => {
      let threw = false;
      let result = undefined;

      try {
        result = calculateHairProteinNeeds(profile);
      } catch (err) {
        threw = true;
      }

      // Implementation may either throw or return null/undefined;
      // both behaviors are allowed as long as it does NOT look like a valid result.
      if (!threw) {
        const looksValid =
          result &&
          typeof result === "object" &&
          typeof result.dailyGrams === "number" &&
          result.dailyGrams > 0;

        expect(looksValid).toBe(false);
      }
    });
  });

  it("degrades gracefully when mealsPerDay is missing or obviously invalid", () => {
    const noMeals = calculateHairProteinNeeds({
      ...BASE_FEMALE_70KG,
      mealsPerDay: undefined
    });

    const oneMeal = calculateHairProteinNeeds({
      ...BASE_FEMALE_70KG,
      mealsPerDay: 1
    });

    expect(noMeals).toBeTruthy();
    expect(typeof noMeals.perMealGrams).toBe("number");

    // 1 meal per day: perMealGrams is essentially the whole daily amount
    const diff = Math.abs(oneMeal.perMealGrams - oneMeal.dailyGrams);
    expect(diff).toBeLessThan(oneMeal.dailyGrams * 0.15 + 0.0001);
  });
});
