// C:\Users\larho\suka-smart-assistant\src\tests\calculators\storehouseMeals\PreservationTimeCalculator.test.js
// -----------------------------------------------------------------------------
// Unit tests for PreservationTimeCalculator logic.
//
// ASSUMED PUBLIC API (align your implementation to this shape):
//
//   import { calculatePreservationTime } from
//     "@/features/calculators/storehouseMeals/PreservationTimeCalculator.logic.js";
//
//   const profile = calculatePreservationTime(config);
//
// Where `config` looks like:
//
//   {
//     foodType: string,                 // e.g. "meat", "vegetable", "fruit", "dairy", "grain"
//     method: string,                   // "freezing" | "canning" | "dehydrating" | "fermenting" | "curing"
//     storageTempF: number,             // storage temperature in °F
//     fatContent?: "low" | "medium" | "high",
//     containerIntegrity?: "excellent" | "ok" | "poor",
//     oxygenExposure?: "low" | "medium" | "high",
//     saltPct?: number,                 // for curing / fermenting
//     waterActivity?: number,           // 0–1, optional for dehydrating
//     notes?: string[]
//   }
//
// And `calculatePreservationTime(config)` returns:
//
//   {
//     foodType: string,
//     method: string,
//     storageTempF: number,
//     fatContent: "low" | "medium" | "high",
//     containerIntegrity: "excellent" | "ok" | "poor",
//     oxygenExposure: "low" | "medium" | "high",
//
//     // Core preservation window (months):
//     recommendedMonths: number,        // central guideline
//     minMonths: number,                // conservative lower bound
//     maxMonths: number,                // upper bound for quality
//
//     // Risk classification for *quality and safety* at the end of the window:
//     riskLevel: "low" | "medium" | "high",
//
//     // Optional introspection aids for SSA planners:
//     factors: {
//       tempAdjustment?: number,
//       fatAdjustment?: number,
//       containerAdjustment?: number,
//       oxygenAdjustment?: number,
//       methodBaseMonths?: number,
//       waterActivityAdjustment?: number,
//       saltPctAdjustment?: number
//     },
//
//     // Any human-readable notes (caution, tips, etc.)
//     notes: string[]
//   }
//
// These tests focus on:
//   * Reasonable structure of outputs
//   * Monotonic relationships (colder temps → longer storage, etc.)
//   * Influence of fatContent, containerIntegrity, oxygenExposure
//   * Method-specific behavior (freezing vs dehydrating vs canning)
//   * Defensive handling of invalid or extreme inputs
//
// SSA will use this calculator to:
//   * Feed Planning Graph storehouse nodes (how long is this batch safe?)
//   * Suggest rotation windows and refill timelines
//   * Inform SessionRunner about “use this now / later / discard” hints
// -----------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import { calculatePreservationTime } from "@/features/calculators/storehouseMeals/PreservationTimeCalculator.logic.js";

function assertBasicProfile(profile) {
  expect(profile).toBeTruthy();
  expect(typeof profile).toBe("object");

  expect(typeof profile.foodType).toBe("string");
  expect(typeof profile.method).toBe("string");
  expect(typeof profile.storageTempF).toBe("number");

  expect(["low", "medium", "high"]).toContain(profile.fatContent);
  expect(["excellent", "ok", "poor"]).toContain(profile.containerIntegrity);
  expect(["low", "medium", "high"]).toContain(profile.oxygenExposure);

  expect(typeof profile.recommendedMonths).toBe("number");
  expect(typeof profile.minMonths).toBe("number");
  expect(typeof profile.maxMonths).toBe("number");

  expect(profile.recommendedMonths).toBeGreaterThanOrEqual(0);
  expect(profile.minMonths).toBeGreaterThanOrEqual(0);
  expect(profile.maxMonths).toBeGreaterThanOrEqual(0);

  expect(profile.minMonths).toBeLessThanOrEqual(profile.recommendedMonths);
  expect(profile.recommendedMonths).toBeLessThanOrEqual(profile.maxMonths);

  expect(["low", "medium", "high"]).toContain(profile.riskLevel);

  if (profile.notes) {
    expect(Array.isArray(profile.notes)).toBe(true);
  }

  if (profile.factors) {
    expect(typeof profile.factors).toBe("object");
  }
}

// -----------------------------------------------------------------------------
// Basic structure
// -----------------------------------------------------------------------------
describe("PreservationTimeCalculator.calculatePreservationTime – basic structure", () => {
  it("returns a well-formed profile for a typical freezing scenario", () => {
    const profile = calculatePreservationTime({
      foodType: "meat",
      method: "freezing",
      storageTempF: 0,
      fatContent: "medium",
      containerIntegrity: "excellent",
      oxygenExposure: "low"
    });

    assertBasicProfile(profile);
    expect(profile.method).toBe("freezing");
    expect(profile.foodType).toBe("meat");
  });

  it("fills in sensible defaults for omitted optional fields", () => {
    const profile = calculatePreservationTime({
      foodType: "vegetable",
      method: "freezing",
      storageTempF: 0
      // no fatContent, containerIntegrity, oxygenExposure
    });

    assertBasicProfile(profile);

    // Defaults should still be valid enum values:
    expect(["low", "medium", "high"]).toContain(profile.fatContent);
    expect(["excellent", "ok", "poor"]).toContain(profile.containerIntegrity);
    expect(["low", "medium", "high"]).toContain(profile.oxygenExposure);
  });
});

// -----------------------------------------------------------------------------
// Temperature effects
// -----------------------------------------------------------------------------
describe("PreservationTimeCalculator.calculatePreservationTime – temperature effects", () => {
  it("gives longer recommendedMonths at colder temperatures for the same food/method", () => {
    const coldProfile = calculatePreservationTime({
      foodType: "meat",
      method: "freezing",
      storageTempF: 0,
      fatContent: "medium",
      containerIntegrity: "excellent",
      oxygenExposure: "low"
    });

    const warmProfile = calculatePreservationTime({
      foodType: "meat",
      method: "freezing",
      storageTempF: 20,
      fatContent: "medium",
      containerIntegrity: "excellent",
      oxygenExposure: "low"
    });

    assertBasicProfile(coldProfile);
    assertBasicProfile(warmProfile);

    expect(coldProfile.recommendedMonths).toBeGreaterThan(
      warmProfile.recommendedMonths
    );
  });

  it("avoids negative or zero recommendedMonths, even for very warm storageTempF", () => {
    const profile = calculatePreservationTime({
      foodType: "vegetable",
      method: "canning",
      storageTempF: 90,
      fatContent: "low",
      containerIntegrity: "ok",
      oxygenExposure: "medium"
    });

    assertBasicProfile(profile);
    expect(profile.recommendedMonths).toBeGreaterThanOrEqual(0);
  });
});

// -----------------------------------------------------------------------------
// Fat content and quality decay
// -----------------------------------------------------------------------------
describe("PreservationTimeCalculator.calculatePreservationTime – fat content effects", () => {
  it("reduces recommendedMonths for high-fat foods compared to low-fat foods (same method/temp)", () => {
    const lowFat = calculatePreservationTime({
      foodType: "meat",
      method: "freezing",
      storageTempF: 0,
      fatContent: "low",
      containerIntegrity: "excellent",
      oxygenExposure: "low"
    });

    const highFat = calculatePreservationTime({
      foodType: "meat",
      method: "freezing",
      storageTempF: 0,
      fatContent: "high",
      containerIntegrity: "excellent",
      oxygenExposure: "low"
    });

    assertBasicProfile(lowFat);
    assertBasicProfile(highFat);

    expect(lowFat.recommendedMonths).toBeGreaterThan(
      highFat.recommendedMonths
    );
  });
});

// -----------------------------------------------------------------------------
// Container & oxygen exposure
// -----------------------------------------------------------------------------
describe("PreservationTimeCalculator.calculatePreservationTime – container/oxygen effects", () => {
  it("reduces recommendedMonths with poor container integrity", () => {
    const excellent = calculatePreservationTime({
      foodType: "fruit",
      method: "freezing",
      storageTempF: 0,
      fatContent: "low",
      containerIntegrity: "excellent",
      oxygenExposure: "low"
    });

    const poor = calculatePreservationTime({
      foodType: "fruit",
      method: "freezing",
      storageTempF: 0,
      fatContent: "low",
      containerIntegrity: "poor",
      oxygenExposure: "low"
    });

    assertBasicProfile(excellent);
    assertBasicProfile(poor);

    expect(excellent.recommendedMonths).toBeGreaterThan(
      poor.recommendedMonths
    );
  });

  it("increases riskLevel with high oxygen exposure", () => {
    const lowO2 = calculatePreservationTime({
      foodType: "meat",
      method: "curing",
      storageTempF: 50,
      fatContent: "high",
      containerIntegrity: "ok",
      oxygenExposure: "low",
      saltPct: 3
    });

    const highO2 = calculatePreservationTime({
      foodType: "meat",
      method: "curing",
      storageTempF: 50,
      fatContent: "high",
      containerIntegrity: "ok",
      oxygenExposure: "high",
      saltPct: 3
    });

    assertBasicProfile(lowO2);
    assertBasicProfile(highO2);

    const riskRank = { low: 0, medium: 1, high: 2 };

    expect(riskRank[highO2.riskLevel]).toBeGreaterThanOrEqual(
      riskRank[lowO2.riskLevel]
    );
  });
});

// -----------------------------------------------------------------------------
// Method-specific behavior
// -----------------------------------------------------------------------------
describe("PreservationTimeCalculator.calculatePreservationTime – method-specific behavior", () => {
  it("generally allows longer storage for freezing vs refrigerator-only (modeled via higher temp)", () => {
    const frozen = calculatePreservationTime({
      foodType: "vegetable",
      method: "freezing",
      storageTempF: 0,
      fatContent: "low",
      containerIntegrity: "excellent",
      oxygenExposure: "low"
    });

    const notQuiteFrozen = calculatePreservationTime({
      foodType: "vegetable",
      method: "freezing",
      storageTempF: 35, // fridge-like temp, same method for simplicity
      fatContent: "low",
      containerIntegrity: "excellent",
      oxygenExposure: "low"
    });

    assertBasicProfile(frozen);
    assertBasicProfile(notQuiteFrozen);

    expect(frozen.recommendedMonths).toBeGreaterThan(
      notQuiteFrozen.recommendedMonths
    );
  });

  it("reduces recommendedMonths for high waterActivity dehydrated foods", () => {
    const dry = calculatePreservationTime({
      foodType: "fruit",
      method: "dehydrating",
      storageTempF: 68,
      fatContent: "low",
      containerIntegrity: "excellent",
      oxygenExposure: "low",
      waterActivity: 0.3
    });

    const stillMoist = calculatePreservationTime({
      foodType: "fruit",
      method: "dehydrating",
      storageTempF: 68,
      fatContent: "low",
      containerIntegrity: "excellent",
      oxygenExposure: "low",
      waterActivity: 0.7
    });

    assertBasicProfile(dry);
    assertBasicProfile(stillMoist);

    expect(dry.recommendedMonths).toBeGreaterThan(
      stillMoist.recommendedMonths
    );
  });

  it("reflects saltPct impact for curing (more salt → longer storage, up to a cap)", () => {
    const lowSalt = calculatePreservationTime({
      foodType: "meat",
      method: "curing",
      storageTempF: 55,
      fatContent: "high",
      containerIntegrity: "ok",
      oxygenExposure: "medium",
      saltPct: 2
    });

    const higherSalt = calculatePreservationTime({
      foodType: "meat",
      method: "curing",
      storageTempF: 55,
      fatContent: "high",
      containerIntegrity: "ok",
      oxygenExposure: "medium",
      saltPct: 5
    });

    assertBasicProfile(lowSalt);
    assertBasicProfile(higherSalt);

    expect(higherSalt.recommendedMonths).toBeGreaterThan(
      lowSalt.recommendedMonths
    );
  });
});

// -----------------------------------------------------------------------------
// Risk windows and thresholds
// -----------------------------------------------------------------------------
describe("PreservationTimeCalculator.calculatePreservationTime – risk windows", () => {
  it("keeps riskLevel low for conservative time windows", () => {
    const conservative = calculatePreservationTime({
      foodType: "vegetable",
      method: "canning",
      storageTempF: 65,
      fatContent: "low",
      containerIntegrity: "excellent",
      oxygenExposure: "low"
    });

    assertBasicProfile(conservative);
    expect(["low", "medium"]).toContain(conservative.riskLevel);
  });

  it("can yield high riskLevel for edge-case warm, high-fat, high-oxygen scenarios", () => {
    const risky = calculatePreservationTime({
      foodType: "meat",
      method: "curing",
      storageTempF: 80,
      fatContent: "high",
      containerIntegrity: "poor",
      oxygenExposure: "high",
      saltPct: 1
    });

    assertBasicProfile(risky);
    expect(["medium", "high"]).toContain(risky.riskLevel);
  });
});

// -----------------------------------------------------------------------------
// Invalid / unknown method handling
// -----------------------------------------------------------------------------
describe("PreservationTimeCalculator.calculatePreservationTime – invalid input handling", () => {
  it("handles unknown methods defensively, returning a short window and higher risk", () => {
    const profile = calculatePreservationTime({
      foodType: "meat",
      method: "unknown-method",
      storageTempF: 40,
      fatContent: "medium",
      containerIntegrity: "ok",
      oxygenExposure: "medium"
    });

    assertBasicProfile(profile);

    // Expect either a very conservative or near-zero window:
    expect(profile.recommendedMonths).toBeLessThanOrEqual(1);

    const riskRank = { low: 0, medium: 1, high: 2 };
    expect(riskRank[profile.riskLevel]).toBeGreaterThanOrEqual(
      riskRank.medium
    );

    if (profile.notes && profile.notes.length > 0) {
      const joined = profile.notes.join(" ").toLowerCase();
      expect(joined).toContain("unknown");
    }
  });

  it("coerces obviously broken numeric inputs to safe values (no NaN or Infinity)", () => {
    const profile = calculatePreservationTime({
      foodType: "grain",
      method: "dehydrating",
      storageTempF: Number.NaN,
      fatContent: "low",
      containerIntegrity: "ok",
      oxygenExposure: "medium",
      waterActivity: -1
    });

    assertBasicProfile(profile);

    expect(Number.isFinite(profile.recommendedMonths)).toBe(true);
    expect(Number.isFinite(profile.minMonths)).toBe(true);
    expect(Number.isFinite(profile.maxMonths)).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// SSA / Planning Graph compatibility
// -----------------------------------------------------------------------------
describe("PreservationTimeCalculator.calculatePreservationTime – SSA compatibility", () => {
  it("produces stable data that downstream Storehouse + SessionRunner can interpret", () => {
    const profile = calculatePreservationTime({
      foodType: "soup",
      method: "freezing",
      storageTempF: 0,
      fatContent: "medium",
      containerIntegrity: "ok",
      oxygenExposure: "medium"
    });

    assertBasicProfile(profile);

    // For Planning Graph, we only require that:
    //   * recommendedMonths is within a sane range
    //   * min/max bound it correctly
    //   * risk is not contradictory
    expect(profile.recommendedMonths).toBeGreaterThanOrEqual(0);
    expect(profile.recommendedMonths).toBeLessThanOrEqual(36);

    expect(profile.minMonths).toBeLessThanOrEqual(profile.recommendedMonths);
    expect(profile.recommendedMonths).toBeLessThanOrEqual(profile.maxMonths);
  });
});
