// C:\Users\larho\suka-smart-assistant\src\tests\planning\stabilityEngine.test.js
// -----------------------------------------------------------------------------
// Tests validating StabilityEngine and weighted scoring behavior
//
// HOW THIS FITS
// --------------
// The StabilityEngine is the core scoring layer behind your Household Stability
// Dashboard + Stability Calculators. It:
//   * Combines dimension scores (food, shelter, income, health, etc.)
//   * Applies weights to reflect household priorities
//   * Produces a 0–100 stability score + per-dimension breakdown
//   * Computes trend information (is the household stabilizing or sliding?)
//   * Emits warnings for critically low dimensions.
//
// SSA will use this engine to:
//   * Power the “Household Stability” card on dashboards
//   * Feed the Planning Graph (stability-aware next steps)
//   * Influence which sessions are suggested in SessionRunner “Now” CTAs.
//
// ASSUMED PUBLIC API (stabilityEngine.js)
// --------------------------------------
// File: "@/services/planning/stabilityEngine.js"
//
// export const DEFAULT_STABILITY_WEIGHTS = {
//   // Example baseline; your implementation can extend this:
//   // food, shelter, income, health, time, social, spiritual, safety, etc.
//   food: 0.2,
//   shelter: 0.2,
//   income: 0.2,
//   health: 0.15,
//   time: 0.15,
//   social: 0.1
// };
//
// /**
//  * @typedef {Object} StabilityDimensions
//  * @property {number} [food]     // 0..1
//  * @property {number} [shelter]  // 0..1
//  * @property {number} [income]   // 0..1
//  * @property {number} [health]   // 0..1
//  * @property {number} [time]     // 0..1
//  * @property {number} [social]   // 0..1
//  * // + Any additional dimensions (safety, transport, etc.), even if not weighted
//  */
//
// /**
//  * @typedef {Object} StabilityScoreBreakdownItem
//  * @property {number} raw       // 0..1 (clamped)
//  * @property {number} weight    // 0..1
//  * @property {number} weighted  // raw * weight (0..1)
//  */
//
// /**
//  * @typedef {Object} StabilityScoreResult
//  * @property {number} score   // 0..100
//  * @property {Record<string, StabilityScoreBreakdownItem>} breakdown
//  * @property {string[]} warnings
//  */
//
// /**
//  * Compute the stability score for a given snapshot.
//  *
//  * @param {Object} params
//  * @param {StabilityDimensions} params.dimensions
//  * @param {Record<string, number>} [params.weights]  // overrides / extends defaults
//  * @returns {StabilityScoreResult}
//  */
// export function computeStabilityScore({ dimensions, weights });
//
// /**
//  * @typedef {Object} StabilityTrendPoint
//  * @property {string} date   // ISO 8601 string
//  * @property {number} score  // 0..100
//  */
//
// /**
//  * @typedef {Object} StabilityTrendResult
//  * @property {"up"|"down"|"flat"} direction
//  * @property {number} deltaPerDay
//  */
//
// /**
//  * Compute stability trend (direction + average daily delta).
//  *
//  * @param {Object} params
//  * @param {StabilityTrendPoint[]} params.history
//  * @returns {StabilityTrendResult}
//  */
// export function computeStabilityTrend({ history });
//
// /**
//  * Derive human-readable warnings from low dimensions.
//  *
//  * @param {Object} params
//  * @param {StabilityDimensions} params.dimensions
//  * @param {number} [params.threshold]  // default 0.3
//  * @returns {string[]} warnings
//  */
// export function deriveStabilityWarnings({ dimensions, threshold });
// -----------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import {
  DEFAULT_STABILITY_WEIGHTS,
  computeStabilityScore,
  computeStabilityTrend,
  deriveStabilityWarnings
} from "@/services/planning/stabilityEngine.js";

/**
 * Helper to compute expected score given weights + raw dimension values.
 * Mirrors the intended implementation logic:
 *   - For each weight key, use dimensions[key] || 0
 *   - Sum(raw * weight) * 100
 *
 * @param {Record<string, number>} weights
 * @param {Record<string, number>} dimensions
 * @returns {number}
 */
function expectedScore(weights, dimensions) {
  let total = 0;
  for (const [key, weight] of Object.entries(weights)) {
    const raw = dimensions[key] ?? 0;
    total += raw * weight;
  }
  return total * 100;
}

// -----------------------------------------------------------------------------
// 1) Weighted scoring with defaults and overrides
// -----------------------------------------------------------------------------

describe("stabilityEngine – computeStabilityScore (default weights)", () => {
  it("computes a weighted stability score using DEFAULT_STABILITY_WEIGHTS", () => {
    const dimensions = {
      food: 1,
      shelter: 0.5,
      income: 0.25
      // all others implicitly 0
    };

    const result = computeStabilityScore({ dimensions });

    expect(typeof result.score).toBe("number");
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);

    // Use the same weight logic the engine is expected to apply.
    const expected = expectedScore(DEFAULT_STABILITY_WEIGHTS, dimensions);
    expect(result.score).toBeCloseTo(expected, 5);

    // Breakdown must include at least all weighted dimensions.
    expect(result.breakdown).toBeTruthy();
    expect(result.breakdown.food).toBeTruthy();
    expect(result.breakdown.shelter).toBeTruthy();
    expect(result.breakdown.income).toBeTruthy();

    const food = result.breakdown.food;
    expect(food.raw).toBeCloseTo(1, 5);
    expect(food.weight).toBeCloseTo(DEFAULT_STABILITY_WEIGHTS.food ?? 0, 5);
    expect(food.weighted).toBeCloseTo(
      (DEFAULT_STABILITY_WEIGHTS.food ?? 0) * 1,
      5
    );
  });

  it("treats missing dimensions as zero but still includes them in the breakdown", () => {
    const dimensions = {
      food: 0.8
      // shelter, income, etc. omitted
    };

    const result = computeStabilityScore({ dimensions });

    // Expected: all non-food dimensions default to raw 0.
    const expected = expectedScore(DEFAULT_STABILITY_WEIGHTS, dimensions);
    expect(result.score).toBeCloseTo(expected, 5);

    // A dimension from the default weights that we didn't provide
    // (e.g., "shelter") must show as raw 0.
    if (DEFAULT_STABILITY_WEIGHTS.shelter != null) {
      expect(result.breakdown.shelter).toBeTruthy();
      expect(result.breakdown.shelter.raw).toBeCloseTo(0, 5);
    }
  });
});

describe("stabilityEngine – computeStabilityScore (custom weights)", () => {
  it("applies custom weights while falling back to defaults for unspecified dimensions", () => {
    const customWeights = {
      food: 0.5, // override
      // "shelter" and others are not set → should fall back to default weights
    };

    const dimensions = {
      food: 0.6,
      shelter: 0.4
    };

    const result = computeStabilityScore({
      dimensions,
      weights: customWeights
    });

    expect(result.breakdown.food.weight).toBeCloseTo(0.5, 5);

    // For shelter, if a default exists, the effective weight should be that default.
    const expectedShelterWeight =
      DEFAULT_STABILITY_WEIGHTS.shelter != null
        ? DEFAULT_STABILITY_WEIGHTS.shelter
        : 0;

    if (expectedShelterWeight > 0) {
      expect(result.breakdown.shelter.weight).toBeCloseTo(
        expectedShelterWeight,
        5
      );
    }

    // Compute expected score using "merged" weights.
    const mergedWeights = { ...DEFAULT_STABILITY_WEIGHTS, ...customWeights };
    const expected = expectedScore(mergedWeights, dimensions);
    expect(result.score).toBeCloseTo(expected, 5);
  });

  it("clamps out-of-range dimension scores to [0, 1]", () => {
    const dimensions = {
      food: 2, // should be clamped to 1
      shelter: -1 // should be clamped to 0
    };

    const result = computeStabilityScore({ dimensions });

    // In the breakdown we expect clamped scores.
    expect(result.breakdown.food.raw).toBeCloseTo(1, 5);
    expect(result.breakdown.shelter.raw).toBeCloseTo(0, 5);

    // Score must match using the clamped values.
    const clampedDimensions = { food: 1, shelter: 0 };
    const expected = expectedScore(DEFAULT_STABILITY_WEIGHTS, clampedDimensions);
    expect(result.score).toBeCloseTo(expected, 5);
  });
});

// -----------------------------------------------------------------------------
// 2) Trend calculation (direction + delta per day)
// -----------------------------------------------------------------------------

describe("stabilityEngine – computeStabilityTrend", () => {
  it("returns 'up' with positive deltaPerDay when stability improves over time", () => {
    const history = [
      { date: "2025-01-01T00:00:00.000Z", score: 50 },
      { date: "2025-01-03T00:00:00.000Z", score: 70 }
    ];

    const trend = computeStabilityTrend({ history });

    expect(trend.direction).toBe("up");
    // Two days between 1st and 3rd, +20 points → +10 per day
    expect(trend.deltaPerDay).toBeCloseTo(10, 5);
  });

  it("returns 'down' with negative deltaPerDay when stability declines", () => {
    const history = [
      { date: "2025-01-01T00:00:00.000Z", score: 80 },
      { date: "2025-01-04T00:00:00.000Z", score: 50 }
    ];

    const trend = computeStabilityTrend({ history });

    expect(trend.direction).toBe("down");
    // 3 days between 1st and 4th, -30 points → -10 per day
    expect(trend.deltaPerDay).toBeCloseTo(-10, 5);
  });

  it("returns 'flat' when there is no effective change or insufficient history", () => {
    const historyFlat = [
      { date: "2025-01-01T00:00:00.000Z", score: 60 },
      { date: "2025-01-02T00:00:00.000Z", score: 60 }
    ];

    const trendFlat = computeStabilityTrend({ history: historyFlat });
    expect(trendFlat.direction).toBe("flat");
    expect(trendFlat.deltaPerDay).toBeCloseTo(0, 5);

    const historySingle = [{ date: "2025-01-01T00:00:00.000Z", score: 60 }];
    const trendSingle = computeStabilityTrend({ history: historySingle });
    expect(trendSingle.direction).toBe("flat");
    expect(trendSingle.deltaPerDay).toBeCloseTo(0, 5);
  });

  it("handles unsorted history by sorting internally by date", () => {
    const history = [
      { date: "2025-01-03T00:00:00.000Z", score: 70 },
      { date: "2025-01-01T00:00:00.000Z", score: 50 }
    ];

    const trend = computeStabilityTrend({ history });
    expect(trend.direction).toBe("up");
    expect(trend.deltaPerDay).toBeCloseTo(10, 5);
  });
});

// -----------------------------------------------------------------------------
// 3) Warnings for low dimensions
// -----------------------------------------------------------------------------

describe("stabilityEngine – deriveStabilityWarnings", () => {
  it("returns warnings when dimensions fall below the default threshold", () => {
    const dimensions = {
      food: 0.9,
      shelter: 0.2, // below default threshold 0.3
      income: 0.4
    };

    const warnings = deriveStabilityWarnings({ dimensions });

    expect(Array.isArray(warnings)).toBe(true);
    expect(warnings.length).toBeGreaterThan(0);

    const combined = warnings.join(" ").toLowerCase();
    expect(combined).toContain("shelter");
  });

  it("honors a custom threshold for critical warnings", () => {
    const dimensions = {
      food: 0.5,
      shelter: 0.35
    };

    // With default threshold (0.3), shelter is okay → no warning
    const defaultWarnings = deriveStabilityWarnings({ dimensions });
    const defaultCombined = defaultWarnings.join(" ").toLowerCase();
    expect(defaultCombined.includes("shelter")).toBe(false);

    // With a stricter threshold (0.4), shelter should now trigger a warning.
    const strictWarnings = deriveStabilityWarnings({
      dimensions,
      threshold: 0.4
    });
    const strictCombined = strictWarnings.join(" ").toLowerCase();
    expect(strictCombined).toContain("shelter");
  });

  it("returns an empty array when all dimensions are above the threshold", () => {
    const dimensions = {
      food: 0.8,
      shelter: 0.9,
      income: 0.7,
      health: 0.85
    };

    const warnings = deriveStabilityWarnings({ dimensions, threshold: 0.3 });
    expect(warnings).toEqual([]);
  });
});
