// C:\Users\larho\suka-smart-assistant\src\tests\calculators\gardenAnimal\SoilAmendmentCalculator.test.js
// -----------------------------------------------------------------------------
// Unit tests for SoilAmendmentCalculator logic.
//
// ASSUMED PUBLIC API (align your implementation to this shape):
//
//   import { calculateSoilAmendments } from
//     "@/features/calculators/gardenAnimal/SoilAmendmentCalculator.logic.js";
//
//   const result = calculateSoilAmendments(config);
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
//     targetCropGroup?: "leafy" | "root" | "fruiting" | "legume" | "mixed",
//     soilTest: {
//       ph: number,
//       organicMatterPct: number,     // 0–20+
//       nitrogenPpm?: number,         // nitrate or total N equivalent
//       phosphorusPpm?: number,       // P or P2O5 equivalent
//       potassiumPpm?: number,        // K or K2O equivalent
//       cec?: number,                 // cation exchange capacity
//       textureClass?: "sand" | "loam" | "clay" | "sandy-loam" | "clay-loam"
//     },
//     goals?: {
//       targetPh?: number,
//       targetOrganicMatterPct?: number,
//       targetNpkProfile?: {
//         nLbPer100SqFt?: number,
//         p2o5LbPer100SqFt?: number,
//         k2oLbPer100SqFt?: number
//       },
//       organicOnly?: boolean,
//       maxApplicationsPerSeason?: number
//     }
//   }
//
// And the calculator returns something like:
//
//   {
//     bed: { id: string, label?: string, areaSqFt: number },
//     soilTest: { ...normalized input + derived fields... },
//     goals: { ...resolved goals... },
//     recommendations: {
//       ph: {
//         direction: "raise" | "lower" | "ok",
//         material: "lime" | "sulfur" | "none",
//         lbPer100SqFt: number,
//         totalLb: number,
//         notes?: string
//       },
//       organicMatter: {
//         neededPctIncrease: number,
//         compostCuFtPer100SqFt: number,
//         totalCompostCuFt: number,
//         coverCropSuggestion?: string
//       },
//       nutrients: {
//         npk: {
//           targetN: number,
//           targetP2O5: number,
//           targetK2O: number,
//           deficitN: number,
//           deficitP2O5: number,
//           deficitK2O: number
//         },
//         blends: [
//           {
//             id: string,
//             label: string,
//             // e.g. 4–4–4 all-purpose organic, 10–10–10 synthetic, etc.
//             nPct: number,
//             p2o5Pct: number,
//             k2oPct: number,
//             lbPer100SqFt: number,
//             totalLb: number,
//             organic: boolean
//           }
//         ]
//       }
//     },
//     warnings?: string[]
//   }
//
// These tests focus on:
//   * Output shape + numeric sanity
//   * pH: raise vs lower vs ok
//   * Organic matter compost recommendations
//   * NPK deficits and blend selection
//   * Organic-only vs mixed recommendations
//   * Defensive behavior and clamping
//   * SSA compatibility: stable, finite, predictable numeric outputs
// -----------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import { calculateSoilAmendments } from "@/features/calculators/gardenAnimal/SoilAmendmentCalculator.logic.js";

function assertFiniteNumber(value) {
  expect(typeof value).toBe("number");
  expect(Number.isFinite(value)).toBe(true);
}

function assertRecommendationsShape(result) {
  expect(result).toBeTruthy();
  expect(typeof result).toBe("object");

  expect(result.bed).toBeTruthy();
  expect(typeof result.bed.id).toBe("string");
  assertFiniteNumber(result.bed.areaSqFt);

  expect(result.soilTest).toBeTruthy();
  assertFiniteNumber(result.soilTest.ph);
  assertFiniteNumber(result.soilTest.organicMatterPct);

  expect(result.goals).toBeTruthy();

  const rec = result.recommendations;
  expect(rec).toBeTruthy();

  // pH block
  expect(rec.ph).toBeTruthy();
  expect(["raise", "lower", "ok"]).toContain(rec.ph.direction);
  expect(["lime", "sulfur", "none"]).toContain(rec.ph.material);
  assertFiniteNumber(rec.ph.lbPer100SqFt);
  assertFiniteNumber(rec.ph.totalLb);

  // OM block
  expect(rec.organicMatter).toBeTruthy();
  assertFiniteNumber(rec.organicMatter.neededPctIncrease);
  assertFiniteNumber(rec.organicMatter.compostCuFtPer100SqFt);
  assertFiniteNumber(rec.organicMatter.totalCompostCuFt);

  // Nutrients
  expect(rec.nutrients).toBeTruthy();
  expect(rec.nutrients.npk).toBeTruthy();
  const npk = rec.nutrients.npk;
  assertFiniteNumber(npk.targetN);
  assertFiniteNumber(npk.targetP2O5);
  assertFiniteNumber(npk.targetK2O);
  assertFiniteNumber(npk.deficitN);
  assertFiniteNumber(npk.deficitP2O5);
  assertFiniteNumber(npk.deficitK2O);

  expect(Array.isArray(rec.nutrients.blends)).toBe(true);
  rec.nutrients.blends.forEach((blend) => {
    expect(typeof blend.id).toBe("string");
    expect(typeof blend.label).toBe("string");
    assertFiniteNumber(blend.nPct);
    assertFiniteNumber(blend.p2o5Pct);
    assertFiniteNumber(blend.k2oPct);
    assertFiniteNumber(blend.lbPer100SqFt);
    assertFiniteNumber(blend.totalLb);
    expect(typeof blend.organic).toBe("boolean");
  });

  if (result.warnings) {
    expect(Array.isArray(result.warnings)).toBe(true);
  }
}

// -----------------------------------------------------------------------------
// Basic loam bed with moderate deficits
// -----------------------------------------------------------------------------
describe("SoilAmendmentCalculator – basic structure and sanity", () => {
  it("returns a well-formed recommendation for a simple loam bed", () => {
    const result = calculateSoilAmendments({
      bed: {
        id: "bed-1",
        label: "Kitchen Garden",
        lengthFt: 10,
        widthFt: 4
      },
      targetCropGroup: "leafy",
      soilTest: {
        ph: 5.8,
        organicMatterPct: 3,
        nitrogenPpm: 10,
        phosphorusPpm: 15,
        potassiumPpm: 60,
        cec: 12,
        textureClass: "loam"
      },
      goals: {
        targetPh: 6.5,
        targetOrganicMatterPct: 5,
        targetNpkProfile: {
          nLbPer100SqFt: 1.0,
          p2o5LbPer100SqFt: 0.75,
          k2oLbPer100SqFt: 0.75
        },
        organicOnly: true,
        maxApplicationsPerSeason: 2
      }
    });

    assertRecommendationsShape(result);

    // This soil is acidic; we should be raising pH with lime.
    expect(result.recommendations.ph.direction).toBe("raise");
    expect(result.recommendations.ph.material).toBe("lime");

    // Organic matter < target → positive increase and compost recommendation
    expect(result.recommendations.organicMatter.neededPctIncrease).toBeGreaterThan(
      0
    );
    expect(
      result.recommendations.organicMatter.compostCuFtPer100SqFt
    ).toBeGreaterThan(0);

    // Since organicOnly is true, all blends should be organic.
    result.recommendations.nutrients.blends.forEach((blend) => {
      expect(blend.organic).toBe(true);
    });
  });
});

// -----------------------------------------------------------------------------
// pH behavior – raise, lower, ok
// -----------------------------------------------------------------------------
describe("SoilAmendmentCalculator – pH recommendations", () => {
  it("recommends raising pH with lime on acidic soils", () => {
    const result = calculateSoilAmendments({
      bed: {
        id: "acid-bed",
        areaSqFt: 100
      },
      soilTest: {
        ph: 5.2,
        organicMatterPct: 4,
        cec: 8,
        textureClass: "sand"
      },
      goals: {
        targetPh: 6.8
      }
    });

    assertRecommendationsShape(result);
    expect(result.recommendations.ph.direction).toBe("raise");
    expect(result.recommendations.ph.material).toBe("lime");
    expect(result.recommendations.ph.lbPer100SqFt).toBeGreaterThan(0);
  });

  it("recommends lowering pH with sulfur on alkaline soils", () => {
    const result = calculateSoilAmendments({
      bed: {
        id: "alk-bed",
        areaSqFt: 100
      },
      soilTest: {
        ph: 7.8,
        organicMatterPct: 2.5,
        cec: 18,
        textureClass: "clay"
      },
      goals: {
        targetPh: 6.6
      }
    });

    assertRecommendationsShape(result);
    expect(result.recommendations.ph.direction).toBe("lower");
    expect(result.recommendations.ph.material).toBe("sulfur");
    expect(result.recommendations.ph.lbPer100SqFt).toBeGreaterThan(0);
  });

  it("reports 'ok' when soil pH is already within a small tolerance of the target", () => {
    const result = calculateSoilAmendments({
      bed: {
        id: "ok-bed",
        areaSqFt: 100
      },
      soilTest: {
        ph: 6.6,
        organicMatterPct: 4,
        cec: 10,
        textureClass: "loam"
      },
      goals: {
        targetPh: 6.5
      }
    });

    assertRecommendationsShape(result);
    expect(result.recommendations.ph.direction).toBe("ok");
    expect(result.recommendations.ph.material).toBe("none");
    // Applications should be essentially 0
    expect(result.recommendations.ph.lbPer100SqFt).toBeGreaterThanOrEqual(0);
    expect(result.recommendations.ph.lbPer100SqFt).toBeLessThan(0.1);
  });
});

// -----------------------------------------------------------------------------
// Organic matter – compost volumes and cover crop hints
// -----------------------------------------------------------------------------
describe("SoilAmendmentCalculator – organic matter recommendations", () => {
  it("suggests compost when organic matter is below target", () => {
    const result = calculateSoilAmendments({
      bed: {
        id: "om-low",
        lengthFt: 12,
        widthFt: 3
      },
      soilTest: {
        ph: 6.5,
        organicMatterPct: 2.5,
        cec: 10,
        textureClass: "sandy-loam"
      },
      goals: {
        targetOrganicMatterPct: 5
      }
    });

    assertRecommendationsShape(result);

    const om = result.recommendations.organicMatter;
    expect(om.neededPctIncrease).toBeGreaterThan(0);
    expect(om.compostCuFtPer100SqFt).toBeGreaterThan(0);
    expect(om.totalCompostCuFt).toBeGreaterThan(0);
  });

  it("keeps compost recommendations minimal when organic matter is above target", () => {
    const result = calculateSoilAmendments({
      bed: {
        id: "om-high",
        areaSqFt: 100
      },
      soilTest: {
        ph: 6.6,
        organicMatterPct: 7,
        cec: 15,
        textureClass: "loam"
      },
      goals: {
        targetOrganicMatterPct: 5
      }
    });

    assertRecommendationsShape(result);

    const om = result.recommendations.organicMatter;
    // If OM is already above target, we expect little or no compost recommendation.
    expect(om.neededPctIncrease).toBeLessThanOrEqual(0);
    expect(om.compostCuFtPer100SqFt).toBeLessThanOrEqual(0);
  });
});

// -----------------------------------------------------------------------------
// NPK deficits and blends
// -----------------------------------------------------------------------------
describe("SoilAmendmentCalculator – nutrient deficits and blends", () => {
  it("calculates positive NPK deficits when soil test is below target", () => {
    const result = calculateSoilAmendments({
      bed: {
        id: "npk-deficit",
        lengthFt: 10,
        widthFt: 4
      },
      targetCropGroup: "fruiting",
      soilTest: {
        ph: 6.5,
        organicMatterPct: 4,
        nitrogenPpm: 5,
        phosphorusPpm: 10,
        potassiumPpm: 40,
        cec: 12,
        textureClass: "loam"
      },
      goals: {
        targetNpkProfile: {
          nLbPer100SqFt: 1.2,
          p2o5LbPer100SqFt: 1.0,
          k2oLbPer100SqFt: 1.0
        },
        organicOnly: false
      }
    });

    assertRecommendationsShape(result);
    const npk = result.recommendations.nutrients.npk;

    expect(npk.deficitN).toBeGreaterThan(0);
    expect(npk.deficitP2O5).toBeGreaterThan(0);
    expect(npk.deficitK2O).toBeGreaterThan(0);

    // At least one blend with non-zero application
    const anyBlendWithRate = result.recommendations.nutrients.blends.some(
      (blend) => blend.lbPer100SqFt > 0
    );
    expect(anyBlendWithRate).toBe(true);
  });

  it("respects organicOnly flag by excluding non-organic blends", () => {
    const result = calculateSoilAmendments({
      bed: {
        id: "organic-only-bed",
        areaSqFt: 120
      },
      soilTest: {
        ph: 6.4,
        organicMatterPct: 3.5,
        nitrogenPpm: 6,
        phosphorusPpm: 8,
        potassiumPpm: 45,
        cec: 10,
        textureClass: "loam"
      },
      goals: {
        targetNpkProfile: {
          nLbPer100SqFt: 1.0,
          p2o5LbPer100SqFt: 0.8,
          k2oLbPer100SqFt: 0.8
        },
        organicOnly: true
      }
    });

    assertRecommendationsShape(result);

    result.recommendations.nutrients.blends.forEach((blend) => {
      expect(blend.organic).toBe(true);
    });
  });
});

// -----------------------------------------------------------------------------
// Defensive behavior – clamping and warnings
// -----------------------------------------------------------------------------
describe("SoilAmendmentCalculator – defensive behavior", () => {
  it("handles missing or invalid numeric values gracefully", () => {
    const result = calculateSoilAmendments({
      bed: {
        id: "weird-bed",
        lengthFt: -10, // invalid
        widthFt: 0 // invalid
      },
      soilTest: {
        ph: -1, // invalid pH
        organicMatterPct: -5, // invalid OM
        nitrogenPpm: -10,
        phosphorusPpm: NaN,
        potassiumPpm: 999999,
        cec: -3,
        textureClass: "sand"
      },
      goals: {
        targetPh: 6.5,
        targetOrganicMatterPct: 4,
        targetNpkProfile: {
          nLbPer100SqFt: -1, // invalid
          p2o5LbPer100SqFt: 0,
          k2oLbPer100SqFt: 0
        }
      }
    });

    assertRecommendationsShape(result);

    // Even with bad inputs, area should be finite & non-negative.
    expect(result.bed.areaSqFt).toBeGreaterThanOrEqual(0);

    // pH recommendation numbers must be finite.
    assertFiniteNumber(result.recommendations.ph.lbPer100SqFt);
    assertFiniteNumber(result.recommendations.ph.totalLb);

    // Compost totals must be finite.
    assertFiniteNumber(result.recommendations.organicMatter.totalCompostCuFt);

    // Deficits must be finite numbers, not NaN or Infinity.
    const npk = result.recommendations.nutrients.npk;
    assertFiniteNumber(npk.deficitN);
    assertFiniteNumber(npk.deficitP2O5);
    assertFiniteNumber(npk.deficitK2O);

    // If warnings exist, they should mention issues.
    if (result.warnings && result.warnings.length > 0) {
      const lower = result.warnings.join(" ").toLowerCase();
      expect(
        lower.includes("invalid") ||
          lower.includes("clamped") ||
          lower.includes("out of range")
      ).toBe(true);
    }
  });

  it("never suggests negative application rates or total weights", () => {
    const result = calculateSoilAmendments({
      bed: {
        id: "no-negative",
        areaSqFt: 80
      },
      soilTest: {
        ph: 7,
        organicMatterPct: 8,
        nitrogenPpm: 50,
        phosphorusPpm: 70,
        potassiumPpm: 200,
        cec: 20,
        textureClass: "clay"
      },
      goals: {
        targetPh: 6.5,
        targetOrganicMatterPct: 5,
        targetNpkProfile: {
          nLbPer100SqFt: 0.5,
          p2o5LbPer100SqFt: 0.5,
          k2oLbPer100SqFt: 0.5
        }
      }
    });

    assertRecommendationsShape(result);

    const phRec = result.recommendations.ph;
    expect(phRec.lbPer100SqFt).toBeGreaterThanOrEqual(0);
    expect(phRec.totalLb).toBeGreaterThanOrEqual(0);

    const omRec = result.recommendations.organicMatter;
    expect(omRec.compostCuFtPer100SqFt).toBeGreaterThanOrEqual(0);
    expect(omRec.totalCompostCuFt).toBeGreaterThanOrEqual(0);

    result.recommendations.nutrients.blends.forEach((blend) => {
      expect(blend.lbPer100SqFt).toBeGreaterThanOrEqual(0);
      expect(blend.totalLb).toBeGreaterThanOrEqual(0);
    });
  });
});

// -----------------------------------------------------------------------------
// SSA / Planning Graph compatibility – stable numbers suitable for scheduling
// -----------------------------------------------------------------------------
describe("SoilAmendmentCalculator – SSA integration checks", () => {
  it("produces stable, finite values for use in SSA Planning Graph and SessionRunner", () => {
    const result = calculateSoilAmendments({
      location: {
        zone: "7b",
        latitude: 34.5,
        longitude: -86.5
      },
      bed: {
        id: "ssa-bed",
        label: "SSA Main Bed",
        lengthFt: 16,
        widthFt: 4
      },
      targetCropGroup: "mixed",
      soilTest: {
        ph: 5.9,
        organicMatterPct: 3.2,
        nitrogenPpm: 12,
        phosphorusPpm: 18,
        potassiumPpm: 90,
        cec: 10,
        textureClass: "loam"
      },
      goals: {
        targetPh: 6.6,
        targetOrganicMatterPct: 5,
        targetNpkProfile: {
          nLbPer100SqFt: 1.1,
          p2o5LbPer100SqFt: 0.9,
          k2oLbPer100SqFt: 0.9
        },
        organicOnly: false,
        maxApplicationsPerSeason: 3
      }
    });

    assertRecommendationsShape(result);

    // Area-based totals should be finite and > 0
    expect(result.bed.areaSqFt).toBeGreaterThan(0);

    const phRec = result.recommendations.ph;
    assertFiniteNumber(phRec.lbPer100SqFt);
    assertFiniteNumber(phRec.totalLb);

    const npk = result.recommendations.nutrients.npk;
    assertFiniteNumber(npk.targetN);
    assertFiniteNumber(npk.targetP2O5);
    assertFiniteNumber(npk.targetK2O);

    // At least one nutrient blend with application > 0
    const anyBlend = result.recommendations.nutrients.blends.some(
      (blend) => blend.lbPer100SqFt > 0
    );
    expect(anyBlend).toBe(true);
  });
});
