// C:\Users\larho\suka-smart-assistant\src\tests\calculators\health\BMICalculator.test.js
// -----------------------------------------------------------------------------
// Unit tests for BMICalculator logic and BMI thresholds.
//
// Assumed BMICalculator.logic.js public API:
//
//   export function calculateBMI(profile)
//   export function classifyBMI(bmi, options?)
//
// Where `profile` looks like:
//   {
//     weightKg: number,
//     heightCm: number
//   }
//
// And `calculateBMI(profile)` returns:
//
//   {
//     bmi: number,          // numeric BMI value
//     rounded?: number,     // optional rounded BMI (1 decimal, etc.)
//     raw?: number          // optional raw float value
//   }
//
// And `classifyBMI(bmi, options?)` returns:
//
//   {
//     category: "underweight" | "normal" | "overweight" | "obese" | string,
//     label: string,        // human-friendly label, e.g. "Normal weight"
//     range: [number, number] | null  // lower/upper bounds for this category
//   }
//
// If your actual logic file uses slightly different names, either:
//   - Update your logic to match this API, OR
//   - Adjust these tests accordingly.
// -----------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import {
  calculateBMI,
  classifyBMI
} from "@/features/calculators/health/BMICalculator.logic.js";

describe("BMICalculator.calculateBMI", () => {
  it("calculates BMI correctly for a valid profile", () => {
    // Example: 80kg, 170cm
    // heightM = 1.7; BMI = 80 / (1.7^2) ≈ 27.68
    const profile = {
      weightKg: 80,
      heightCm: 170
    };

    const result = calculateBMI(profile);

    expect(result).toBeTruthy();
    expect(typeof result).toBe("object");
    expect(typeof result.bmi).toBe("number");

    const expected = 80 / (1.7 * 1.7);

    // Allow a small numerical tolerance
    const diff = Math.abs(result.bmi - expected);
    expect(diff).toBeLessThan(0.05);

    // If rounded is present, it should be close to bmi and have 1 decimal place
    if (typeof result.rounded === "number") {
      expect(Math.abs(result.rounded - result.bmi)).toBeLessThan(0.1);
    }
  });

  it("handles a different profile with sane ranges", () => {
    const profile = {
      weightKg: 60,
      heightCm: 160
    };

    const result = calculateBMI(profile);

    expect(result).toBeTruthy();
    expect(typeof result.bmi).toBe("number");

    // Sanity range for typical adult
    expect(result.bmi).toBeGreaterThan(15);
    expect(result.bmi).toBeLessThan(40);
  });

  it("throws or returns null for invalid input (zero or negative values)", () => {
    const badProfiles = [
      { weightKg: 0, heightCm: 170 },
      { weightKg: 80, heightCm: 0 },
      { weightKg: -5, heightCm: 170 },
      { weightKg: 80, heightCm: -10 }
    ];

    badProfiles.forEach((profile) => {
      let threw = false;
      let result = undefined;

      try {
        result = calculateBMI(profile);
      } catch (err) {
        threw = true;
      }

      // Implementation may either throw or return null/undefined;
      // both behaviors are allowed as long as it's not a valid number.
      if (!threw) {
        expect(result === null || result === undefined).toBe(true);
      }
    });
  });
});

describe("BMICalculator.classifyBMI", () => {
  it("classifies underweight BMI correctly (< 18.5)", () => {
    const bmi = 17.5;
    const classification = classifyBMI(bmi);

    expect(classification).toBeTruthy();
    expect(typeof classification.category).toBe("string");
    expect(classification.category.toLowerCase()).toContain("under");
    if (classification.range) {
      expect(classification.range[1]).toBeLessThan(18.5 + 0.01);
    }
  });

  it("classifies normal BMI correctly (18.5–24.9)", () => {
    const bmi = 22.0;
    const classification = classifyBMI(bmi);

    expect(classification).toBeTruthy();
    expect(typeof classification.category).toBe("string");
    // Accept variations like "normal", "normal weight"
    expect(classification.category.toLowerCase()).toContain("normal");
    if (classification.range) {
      expect(classification.range[0]).toBeLessThanOrEqual(18.5);
      expect(classification.range[1]).toBeGreaterThanOrEqual(24.9 - 0.1);
    }
  });

  it("classifies overweight BMI correctly (25–29.9)", () => {
    const bmi = 27.5;
    const classification = classifyBMI(bmi);

    expect(classification).toBeTruthy();
    expect(typeof classification.category).toBe("string");
    expect(classification.category.toLowerCase()).toContain("over");
    if (classification.range) {
      expect(classification.range[0]).toBeGreaterThanOrEqual(25 - 0.1);
      expect(classification.range[1]).toBeLessThanOrEqual(29.9 + 0.1);
    }
  });

  it("classifies obese BMI correctly (>= 30)", () => {
    const bmi = 32.0;
    const classification = classifyBMI(bmi);

    expect(classification).toBeTruthy();
    expect(typeof classification.category).toBe("string");
    expect(classification.category.toLowerCase()).toContain("obes");
    if (classification.range) {
      expect(classification.range[0]).toBeGreaterThanOrEqual(30 - 0.1);
    }
  });

  it("handles boundary conditions at exact thresholds", () => {
    const thresholds = [
      { bmi: 18.5, expected: "normal" },
      { bmi: 24.9, expected: "normal" },
      { bmi: 25.0, expected: "over" },
      { bmi: 29.9, expected: "over" },
      { bmi: 30.0, expected: "obes" }
    ];

    thresholds.forEach(({ bmi, expected }) => {
      const classification = classifyBMI(bmi);
      const cat = classification.category.toLowerCase();

      // We don't assert exact category string, just that it
      // contains the expected keyword.
      expect(cat.includes(expected)).toBe(true);
    });
  });

  it("returns a sensible fallback for extreme BMI values", () => {
    const veryLow = classifyBMI(10);
    const veryHigh = classifyBMI(60);

    // Implementation-specific categories are allowed, but they should at least
    // be strings and not throw.
    expect(typeof veryLow.category).toBe("string");
    expect(typeof veryHigh.category).toBe("string");
  });
});
