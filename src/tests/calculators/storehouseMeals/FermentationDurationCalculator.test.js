// C:\Users\larho\suka-smart-assistant\src\tests\calculators\storehouseMeals\FermentationDurationCalculator.test.js
// -----------------------------------------------------------------------------
// Unit tests for FermentationDurationCalculator logic.
//
// ASSUMED PUBLIC API (align your implementation to this shape):
//
//   import { calculateFermentationDuration } from
//     "@/features/calculators/storehouseMeals/FermentationDurationCalculator.logic.js";
//
//   const result = calculateFermentationDuration(config);
//
// Where `config` looks like:
//
//   {
//     productType: string,        // "vegetable" | "dairy" | "grain" | "beverage" | "meat" | ...
//     style?: string,             // "sauerkraut" | "kimchi" | "yogurt" | "sourdough" | etc.
//     tempF: number,              // fermentation temperature in °F
//     unit?: "F" | "C",           // optional; if "C", convert to F internally
//
//     saltPct?: number,           // 0–1 brine/mixture salt percentage (w/w)
//     sugarPct?: number,          // 0–1 sugar percentage (for beverages, kefir, etc.)
//     starterType?: string,       // "wild" | "inoculated" | "commercial"
//     inoculationPct?: number,    // 0–1 ratio of starter to batch
//     vesselVolumeL?: number,     // batch size in liters
//     altitudeFt?: number,        // optional; may tweak duration slightly
//     targetProfile?: string      // "quick" | "standard" | "slow"
//   }
//
// And the calculator returns:
//
//   {
//     productType: string,
//     style?: string,
//     tempF: number,
//     saltPct: number,
//     sugarPct: number,
//     starterType: string | null,
//     inoculationPct: number,
//
//     minDays: number,
//     maxDays: number,
//     recommendedDays: number,
//
//     // Derived profile information
//     profile?: {
//       lacticFocus?: number,     // 0–1
//       yeastEmphasis?: number,   // 0–1
//       aceticRisk?: number       // 0–1
//     },
//
//     warnings?: string[],
//     notes?: string
//   }
//
// These tests focus on:
//   * Shape and numeric sanity of the output
//   * Monotonic relations: tempF, saltPct, starterType, targetProfile
//   * Handling of °C vs °F units
//   * Defensive handling of weird inputs
//   * SSA compatibility (stable, non-negative durations)
// -----------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import { calculateFermentationDuration } from "@/features/calculators/storehouseMeals/FermentationDurationCalculator.logic.js";

function assertBasicDuration(result) {
  expect(result).toBeTruthy();
  expect(typeof result).toBe("object");

  expect(typeof result.productType).toBe("string");
  if (result.style !== undefined && result.style !== null) {
    expect(typeof result.style).toBe("string");
  }

  expect(typeof result.tempF).toBe("number");
  expect(typeof result.saltPct).toBe("number");
  expect(typeof result.sugarPct).toBe("number");
  expect(typeof result.inoculationPct).toBe("number");

  expect(typeof result.minDays).toBe("number");
  expect(typeof result.maxDays).toBe("number");
  expect(typeof result.recommendedDays).toBe("number");

  expect(result.minDays).toBeGreaterThanOrEqual(0);
  expect(result.maxDays).toBeGreaterThanOrEqual(result.minDays);
  expect(result.recommendedDays).toBeGreaterThanOrEqual(result.minDays);
  expect(result.recommendedDays).toBeLessThanOrEqual(result.maxDays + 0.001);

  if (result.profile) {
    expect(typeof result.profile).toBe("object");
    if (typeof result.profile.lacticFocus === "number") {
      expect(result.profile.lacticFocus).toBeGreaterThanOrEqual(0);
      expect(result.profile.lacticFocus).toBeLessThanOrEqual(1);
    }
    if (typeof result.profile.yeastEmphasis === "number") {
      expect(result.profile.yeastEmphasis).toBeGreaterThanOrEqual(0);
      expect(result.profile.yeastEmphasis).toBeLessThanOrEqual(1);
    }
    if (typeof result.profile.aceticRisk === "number") {
      expect(result.profile.aceticRisk).toBeGreaterThanOrEqual(0);
      expect(result.profile.aceticRisk).toBeLessThanOrEqual(1);
    }
  }

  if (result.warnings) {
    expect(Array.isArray(result.warnings)).toBe(true);
  }

  // Sanity: tempF should be in a plausible range if user passed something reasonable
  expect(result.tempF).toBeGreaterThanOrEqual(32 - 5); // allow some defensive clamping
  expect(result.tempF).toBeLessThanOrEqual(120 + 5);
}

// -----------------------------------------------------------------------------
// Basic behavior by product type
// -----------------------------------------------------------------------------
describe("FermentationDurationCalculator.calculateFermentationDuration – basic structure", () => {
  it("returns a well-formed duration object for a typical sauerkraut", () => {
    const result = calculateFermentationDuration({
      productType: "vegetable",
      style: "sauerkraut",
      tempF: 68,
      saltPct: 0.025,
      starterType: "wild",
      inoculationPct: 0,
      vesselVolumeL: 5,
      targetProfile: "standard"
    });

    assertBasicDuration(result);
    expect(result.productType).toBe("vegetable");
    expect(result.style).toBe("sauerkraut");
  });

  it("returns a well-formed duration object for a yogurt-style dairy ferment", () => {
    const result = calculateFermentationDuration({
      productType: "dairy",
      style: "yogurt",
      tempF: 110,
      starterType: "inoculated",
      inoculationPct: 0.05,
      sugarPct: 0
    });

    assertBasicDuration(result);
    expect(result.productType).toBe("dairy");

    // Yogurt ferments are usually much faster than vegetables
    expect(result.maxDays).toBeLessThanOrEqual(2);
  });
});

// -----------------------------------------------------------------------------
// Temperature effects
// -----------------------------------------------------------------------------
describe("FermentationDurationCalculator.calculateFermentationDuration – temperature behavior", () => {
  it("shortens recommended duration at higher temperatures (within safe bounds)", () => {
    const cool = calculateFermentationDuration({
      productType: "vegetable",
      style: "sauerkraut",
      tempF: 65,
      saltPct: 0.025,
      starterType: "wild"
    });

    const warm = calculateFermentationDuration({
      productType: "vegetable",
      style: "sauerkraut",
      tempF: 75,
      saltPct: 0.025,
      starterType: "wild"
    });

    assertBasicDuration(cool);
    assertBasicDuration(warm);

    expect(warm.recommendedDays).toBeLessThan(cool.recommendedDays);
  });

  it("clamps or warns when temperatures are unrealistically low or high", () => {
    const tooCold = calculateFermentationDuration({
      productType: "vegetable",
      tempF: -10, // nonsense temp
      saltPct: 0.03
    });

    const tooHot = calculateFermentationDuration({
      productType: "vegetable",
      tempF: 180, // also nonsense
      saltPct: 0.03
    });

    assertBasicDuration(tooCold);
    assertBasicDuration(tooHot);

    if (tooCold.warnings && tooCold.warnings.length > 0) {
      const joined = tooCold.warnings.join(" ").toLowerCase();
      expect(joined).toContain("temperature");
    }

    if (tooHot.warnings && tooHot.warnings.length > 0) {
      const joined = tooHot.warnings.join(" ").toLowerCase();
      expect(joined).toContain("temperature");
    }
  });
});

// -----------------------------------------------------------------------------
// Salt and starter effects
// -----------------------------------------------------------------------------
describe("FermentationDurationCalculator.calculateFermentationDuration – salt & starter", () => {
  it("increases duration with higher salt percentage for vegetables", () => {
    const lowSalt = calculateFermentationDuration({
      productType: "vegetable",
      style: "kimchi",
      tempF: 70,
      saltPct: 0.02,
      starterType: "wild"
    });

    const highSalt = calculateFermentationDuration({
      productType: "vegetable",
      style: "kimchi",
      tempF: 70,
      saltPct: 0.04,
      starterType: "wild"
    });

    assertBasicDuration(lowSalt);
    assertBasicDuration(highSalt);

    expect(highSalt.recommendedDays).toBeGreaterThanOrEqual(
      lowSalt.recommendedDays
    );
  });

  it("shortens duration for inoculated ferments vs wild ferments", () => {
    const wild = calculateFermentationDuration({
      productType: "dairy",
      style: "kefir",
      tempF: 72,
      saltPct: 0,
      sugarPct: 0.08,
      starterType: "wild",
      inoculationPct: 0.01
    });

    const inoculated = calculateFermentationDuration({
      productType: "dairy",
      style: "kefir",
      tempF: 72,
      saltPct: 0,
      sugarPct: 0.08,
      starterType: "inoculated",
      inoculationPct: 0.05
    });

    assertBasicDuration(wild);
    assertBasicDuration(inoculated);

    expect(inoculated.recommendedDays).toBeLessThan(
      wild.recommendedDays
    );
  });

  it("handles extreme saltPct or inoculationPct values defensively", () => {
    const weird = calculateFermentationDuration({
      productType: "vegetable",
      tempF: 68,
      saltPct: 2, // nonsense
      inoculationPct: -0.5
    });

    assertBasicDuration(weird);
    expect(weird.saltPct).toBeGreaterThanOrEqual(0);
    expect(weird.saltPct).toBeLessThanOrEqual(1);
    expect(weird.inoculationPct).toBeGreaterThanOrEqual(0);
    expect(weird.inoculationPct).toBeLessThanOrEqual(1);

    if (weird.warnings && weird.warnings.length > 0) {
      const joined = weird.warnings.join(" ").toLowerCase();
      expect(joined).toContain("salt");
    }
  });
});

// -----------------------------------------------------------------------------
// Target profile and volume/altitude behavior
// -----------------------------------------------------------------------------
describe("FermentationDurationCalculator.calculateFermentationDuration – target profile & batch adjustments", () => {
  it("shortens duration when targetProfile is 'quick' and lengthens when 'slow'", () => {
    const quick = calculateFermentationDuration({
      productType: "vegetable",
      style: "sauerkraut",
      tempF: 70,
      saltPct: 0.025,
      targetProfile: "quick"
    });

    const standard = calculateFermentationDuration({
      productType: "vegetable",
      style: "sauerkraut",
      tempF: 70,
      saltPct: 0.025,
      targetProfile: "standard"
    });

    const slow = calculateFermentationDuration({
      productType: "vegetable",
      style: "sauerkraut",
      tempF: 70,
      saltPct: 0.025,
      targetProfile: "slow"
    });

    assertBasicDuration(quick);
    assertBasicDuration(standard);
    assertBasicDuration(slow);

    expect(quick.recommendedDays).toBeLessThan(standard.recommendedDays);
    expect(slow.recommendedDays).toBeGreaterThanOrEqual(
      standard.recommendedDays
    );
  });

  it("slightly adjusts duration for large vesselVolumeL vs small batches", () => {
    const small = calculateFermentationDuration({
      productType: "vegetable",
      tempF: 70,
      saltPct: 0.025,
      vesselVolumeL: 1
    });

    const large = calculateFermentationDuration({
      productType: "vegetable",
      tempF: 70,
      saltPct: 0.025,
      vesselVolumeL: 50
    });

    assertBasicDuration(small);
    assertBasicDuration(large);

    // Not necessarily huge, but large batches often move a bit slower
    expect(large.recommendedDays).toBeGreaterThanOrEqual(
      small.recommendedDays - 0.5
    );
  });

  it("optionally adjusts for altitudeFt without breaking duration ranges", () => {
    const seaLevel = calculateFermentationDuration({
      productType: "beverage",
      style: "kombucha",
      tempF: 75,
      sugarPct: 0.12,
      altitudeFt: 0
    });

    const highAltitude = calculateFermentationDuration({
      productType: "beverage",
      style: "kombucha",
      tempF: 75,
      sugarPct: 0.12,
      altitudeFt: 6000
    });

    assertBasicDuration(seaLevel);
    assertBasicDuration(highAltitude);

    // Behavior can differ by implementation, but shouldn't blow up:
    // just ensure both are sane and within plausible ranges (< 60 days).
    expect(seaLevel.maxDays).toBeLessThanOrEqual(60);
    expect(highAltitude.maxDays).toBeLessThanOrEqual(60);
  });
});

// -----------------------------------------------------------------------------
// Unit handling (C vs F)
// -----------------------------------------------------------------------------
describe("FermentationDurationCalculator.calculateFermentationDuration – unit handling", () => {
  it("accepts Celsius input and converts correctly to tempF internally", () => {
    // 21°C ≈ 69.8°F
    const fahrenheitBaseline = calculateFermentationDuration({
      productType: "vegetable",
      tempF: 70,
      saltPct: 0.025
    });

    const celsiusInput = calculateFermentationDuration({
      productType: "vegetable",
      tempF: 21, // interpreted as °C when unit: 'C'
      unit: "C",
      saltPct: 0.025
    });

    assertBasicDuration(fahrenheitBaseline);
    assertBasicDuration(celsiusInput);

    const ratio =
      celsiusInput.recommendedDays / fahrenheitBaseline.recommendedDays;

    // Should be very close (within 10%)
    expect(ratio).toBeGreaterThan(0.9);
    expect(ratio).toBeLessThan(1.1);
  });
});

// -----------------------------------------------------------------------------
// Defensive behavior
// -----------------------------------------------------------------------------
describe("FermentationDurationCalculator.calculateFermentationDuration – defensive behavior", () => {
  it("handles missing or unknown productType gracefully", () => {
    const result = calculateFermentationDuration({
      productType: "space-pickle", // unknown
      tempF: 70,
      saltPct: 0.03
    });

    assertBasicDuration(result);
    expect(result.productType).toBe("space-pickle");
  });

  it("handles missing tempF by falling back to a safe default", () => {
    const result = calculateFermentationDuration({
      productType: "vegetable",
      saltPct: 0.03
    });

    assertBasicDuration(result);
  });
});

// -----------------------------------------------------------------------------
// SSA / Planning Graph compatibility
// -----------------------------------------------------------------------------
describe("FermentationDurationCalculator.calculateFermentationDuration – SSA compatibility checks", () => {
  it("returns durations that can be translated into preservation sessions without contradictions", () => {
    const result = calculateFermentationDuration({
      productType: "vegetable",
      style: "sauerkraut",
      tempF: 70,
      saltPct: 0.025,
      starterType: "wild",
      vesselVolumeL: 5
    });

    assertBasicDuration(result);

    // For SSA planning, we only need to ensure:
    //   * durations are finite and non-negative
    //   * recommendedDays is between minDays and maxDays
    expect(Number.isFinite(result.minDays)).toBe(true);
    expect(Number.isFinite(result.maxDays)).toBe(true);
    expect(Number.isFinite(result.recommendedDays)).toBe(true);

    expect(result.recommendedDays).toBeGreaterThanOrEqual(result.minDays);
    expect(result.recommendedDays).toBeLessThanOrEqual(
      result.maxDays + 0.0001
    );
  });
});
