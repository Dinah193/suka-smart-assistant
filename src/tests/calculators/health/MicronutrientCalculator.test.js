// C:\Users\larho\suka-smart-assistant\src\tests\calculators\health\MicronutrientCalculator.test.js
// -----------------------------------------------------------------------------
// Unit tests for MicronutrientCalculator logic and schema-style compliance.
//
// Assumed MicronutrientCalculator.logic.js public API:
//
//   export function calculateMicronutrients(profile)
//   export const MICRONUTRIENT_SCHEMA
//
// Where `profile` looks like (extend as needed in your implementation):
//   {
//     sex: "female" | "male",
//     ageYears: number,
//     weightKg?: number,
//     heightCm?: number,
//     lifeStage?: "adult" | "pregnancy" | "lactation" | "child" | string,
//     activityLevel?: "sedentary" | "light" | "moderate" | "active" | "athlete",
//   }
//
// And `calculateMicronutrients(profile)` returns an object like:
//
//   {
//     calories: number,               // optional, if coupled with macros
//     micronutrients: {
//       calciumMg: number,
//       ironMg: number,
//       magnesiumMg: number,
//       zincMg: number,
//       vitaminAmcg: number,
//       vitaminCmg: number,
//       vitaminDmcg: number,
//       vitaminEmg: number,
//       vitaminKmcg: number,
//       b1mg: number,
//       b2mg: number,
//       b3mg: number,
//       b5mg: number,
//       b6mg: number,
//       b7mcg: number,
//       b9mcg: number,
//       b12mcg: number,
//       // plus any extra trace nutrients your system uses
//     },
//     method?: string,                // e.g. "RDA-US-2020" or similar
//     notes?: string
//   }
//
// MICRONUTRIENT_SCHEMA is assumed to be a JSON-Schema-style object that
// describes the `micronutrients` payload above, with at least:
//
//   {
//     $id?: string,
//     type: "object",
//     properties: { ... },
//     required: [...]
//   }
//
// If your actual logic file uses slightly different names, either:
//   - Update your logic to match this API, OR
//   - Adjust these tests accordingly.
// -----------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import {
  calculateMicronutrients,
  MICRONUTRIENT_SCHEMA
} from "@/features/calculators/health/MicronutrientCalculator.logic.js";

// Minimal adult reference profiles to compare behavior
const FEMALE_30 = Object.freeze({
  sex: "female",
  ageYears: 30,
  lifeStage: "adult",
  weightKg: 75,
  heightCm: 165,
  activityLevel: "moderate"
});

const MALE_30 = Object.freeze({
  sex: "male",
  ageYears: 30,
  lifeStage: "adult",
  weightKg: 85,
  heightCm: 178,
  activityLevel: "moderate"
});

const PREGNANT_30 = Object.freeze({
  sex: "female",
  ageYears: 30,
  lifeStage: "pregnancy",
  weightKg: 80,
  heightCm: 165,
  activityLevel: "light"
});

const CHILD_10 = Object.freeze({
  sex: "female",
  ageYears: 10,
  lifeStage: "child",
  weightKg: 35,
  heightCm: 140,
  activityLevel: "light"
});

// Nutrient keys we expect to exist in your calculator.
// You can add more keys in your implementation; tests will allow that.
const CORE_MICRO_KEYS = [
  "calciumMg",
  "ironMg",
  "magnesiumMg",
  "zincMg",
  "vitaminAmcg",
  "vitaminCmg",
  "vitaminDmcg",
  "vitaminEmg",
  "vitaminKmcg",
  "b1mg",
  "b2mg",
  "b3mg",
  "b5mg",
  "b6mg",
  "b7mcg",
  "b9mcg",
  "b12mcg"
];

describe("MicronutrientCalculator.calculateMicronutrients", () => {
  it("returns a micronutrient object with all core keys for a standard adult profile", () => {
    const result = calculateMicronutrients(FEMALE_30);

    expect(result).toBeTruthy();
    expect(typeof result).toBe("object");
    expect(result.micronutrients).toBeTruthy();
    expect(typeof result.micronutrients).toBe("object");

    CORE_MICRO_KEYS.forEach((key) => {
      expect(result.micronutrients.hasOwnProperty(key)).toBe(true);
      const value = result.micronutrients[key];
      expect(typeof value).toBe("number");
      // sanity range – no zeros or absurd values
      expect(value).toBeGreaterThan(0);
      expect(value).toBeLessThan(10000);
    });

    if (result.method) {
      expect(typeof result.method).toBe("string");
    }
    if (result.notes) {
      expect(typeof result.notes).toBe("string");
    }
  });

  it("adapts micronutrient requirements by sex (male vs female) for iron and calories", () => {
    const female = calculateMicronutrients(FEMALE_30);
    const male = calculateMicronutrients(MALE_30);

    const fMicro = female.micronutrients;
    const mMicro = male.micronutrients;

    // Depending on your model, male calories might be higher
    if (typeof female.calories === "number" && typeof male.calories === "number") {
      expect(male.calories).toBeGreaterThan(female.calories);
    }

    // For iron, adult females typically have higher requirements than adult males.
    // We don't require exact values, just a directional trend.
    if (typeof fMicro.ironMg === "number" && typeof mMicro.ironMg === "number") {
      expect(fMicro.ironMg).toBeGreaterThan(mMicro.ironMg);
    }
  });

  it("increases key micronutrients for pregnancy (e.g., iron, folate, some B-vitamins)", () => {
    const adultFemale = calculateMicronutrients(FEMALE_30).micronutrients;
    const pregnant = calculateMicronutrients(PREGNANT_30).micronutrients;

    // Typical: Iron, folate, some B vitamins increase in pregnancy
    expect(pregnant.ironMg).toBeGreaterThan(adultFemale.ironMg);
    expect(pregnant.b9mcg).toBeGreaterThan(adultFemale.b9mcg);

    // Many systems also slightly raise some B vitamins and maybe calcium
    expect(pregnant.b12mcg).toBeGreaterThanOrEqual(adultFemale.b12mcg);
    expect(pregnant.calciumMg).toBeGreaterThanOrEqual(adultFemale.calciumMg - 1);
  });

  it("reduces certain micronutrient requirements for children relative to adults", () => {
    const adult = calculateMicronutrients(FEMALE_30).micronutrients;
    const child = calculateMicronutrients(CHILD_10).micronutrients;

    // Many micronutrients are lower for children vs adults (though not all).
    // We'll check a few where this is almost always true: zinc, magnesium.
    expect(child.zincMg).toBeLessThan(adult.zincMg);
    expect(child.magnesiumMg).toBeLessThan(adult.magnesiumMg);
  });

  it("throws or returns null/undefined for clearly invalid input", () => {
    const badProfiles = [
      { sex: "female", ageYears: -1 },
      { sex: "male", ageYears: 0 },
      { sex: "female", ageYears: 30, weightKg: -10, heightCm: 160 },
      { sex: "male", ageYears: 30, weightKg: 80, heightCm: 0 }
    ];

    badProfiles.forEach((profile) => {
      let threw = false;
      let result = undefined;

      try {
        result = calculateMicronutrients(profile);
      } catch (err) {
        threw = true;
      }

      // Implementation may either throw or return null/undefined.
      if (!threw) {
        expect(result === null || result === undefined).toBe(true);
      }
    });
  });
});

describe("MicronutrientCalculator MICRONUTRIENT_SCHEMA compliance", () => {
  it("exposes a JSON-Schema-like object for micronutrient results", () => {
    expect(MICRONUTRIENT_SCHEMA).toBeTruthy();
    expect(typeof MICRONUTRIENT_SCHEMA).toBe("object");

    expect(MICRONUTRIENT_SCHEMA.type).toBe("object");
    expect(typeof MICRONUTRIENT_SCHEMA.properties).toBe("object");
    expect(Array.isArray(MICRONUTRIENT_SCHEMA.required)).toBe(true);

    // All core micronutrient keys should appear in the schema properties
    CORE_MICRO_KEYS.forEach((key) => {
      expect(MICRONUTRIENT_SCHEMA.properties.hasOwnProperty(key)).toBe(true);
      const prop = MICRONUTRIENT_SCHEMA.properties[key];
      expect(prop).toBeTruthy();
      expect(typeof prop).toBe("object");
      // type likely number for all core nutrients
      if (prop.type) {
        expect(prop.type === "number" || prop.type === "integer").toBe(true);
      }
    });
  });

  it("produces results that are consistent with MICRONUTRIENT_SCHEMA properties & required list", () => {
    const sample = calculateMicronutrients(FEMALE_30).micronutrients;

    // Every required field in the schema must exist in the sample
    MICRONUTRIENT_SCHEMA.required.forEach((requiredKey) => {
      expect(sample.hasOwnProperty(requiredKey)).toBe(true);
      const val = sample[requiredKey];
      expect(typeof val).toBe("number");
    });

    // Every field in the sample should be declared in the schema properties
    Object.keys(sample).forEach((key) => {
      expect(MICRONUTRIENT_SCHEMA.properties.hasOwnProperty(key)).toBe(true);
    });
  });

  it("keeps micronutrient values within schema-defined minimum and maximum if those are specified", () => {
    const sample = calculateMicronutrients(FEMALE_30).micronutrients;

    Object.keys(sample).forEach((key) => {
      const val = sample[key];
      const prop = MICRONUTRIENT_SCHEMA.properties[key];

      if (!prop) return;

      if (typeof prop.minimum === "number") {
        expect(val).toBeGreaterThanOrEqual(prop.minimum);
      }
      if (typeof prop.maximum === "number") {
        expect(val).toBeLessThanOrEqual(prop.maximum);
      }
    });
  });
});
