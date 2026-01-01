// C:\Users\larho\suka-smart-assistant\src\tests\calculators\storehouseMeals\FreezerSpaceCalculator.test.js
// -----------------------------------------------------------------------------
// Unit tests for FreezerSpaceCalculator logic.
//
// ASSUMED PUBLIC API (align your implementation to this shape):
//
//   import { calculateFreezerSpace } from
//     "@/features/calculators/storehouseMeals/FreezerSpaceCalculator.logic.js";
//
//   const result = calculateFreezerSpace(config);
//
// Where `config` looks like:
//
//   {
//     capacityCuFt: number,        // total nominal freezer capacity in cubic feet
//     reservedPct?: number,        // 0–1 fraction reserved for non-planned items
//     layout?: {
//       shelves?: number,
//       baskets?: number,
//       deepChest?: boolean
//     },
//     items: [
//       {
//         id?: string,
//         name?: string,
//         count: number,                 // units of this item
//         volumePerUnitCuFt?: number,    // if known directly
//         volumePerUnitL?: number,       // OR volume in liters
//         packagingShape?: "box" | "bag" | "round" | "irregular",
//         stackable?: boolean,
//         packingEfficiency?: number,    // 0–1, overrides defaults
//         domainTag?: "meat" | "veg" | "prepared" | "bulk" | string
//       },
//       ...
//     ]
//   }
//
// And the calculator returns:
//
//   {
//     capacityCuFt: number,
//     reservedPct: number,
//     effectiveCapacityCuFt: number,
//
//     requiredCuFt: number,
//     utilizationPct: number,           // requiredCuFt / effectiveCapacityCuFt * 100
//     fits: boolean,                    // requiredCuFt <= effectiveCapacityCuFt
//
//     byDomain?: {
//       [domainTag: string]: {
//         requiredCuFt: number,
//         utilizationPct: number
//       }
//     },
//
//     layoutHints?: {
//       deepShelvesRecommended?: boolean,
//       basketsRecommended?: boolean,
//       layerSuggestions?: Array<{
//         domainTag: string,
//         layerIndex: number,
//         approxCuFt: number
//       }>
//     },
//
//     warnings?: string[]
//   }
//
// These tests focus on:
//   * Shape and numeric sanity of the output
//   * Capacity / utilization behavior
//   * Effects of reservedPct
//   * Effects of packing efficiency (via packagingShape / stackable)
//   * Handling of liters vs cubic feet
//   * Defensive behavior for weird inputs
//   * SSA compatibility for Planning Graph & SessionRunner
// -----------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import { calculateFreezerSpace } from "@/features/calculators/storehouseMeals/FreezerSpaceCalculator.logic.js";

function assertBaseShape(result) {
  expect(result).toBeTruthy();
  expect(typeof result).toBe("object");

  expect(typeof result.capacityCuFt).toBe("number");
  expect(typeof result.reservedPct).toBe("number");
  expect(typeof result.effectiveCapacityCuFt).toBe("number");
  expect(typeof result.requiredCuFt).toBe("number");
  expect(typeof result.utilizationPct).toBe("number");
  expect(typeof result.fits).toBe("boolean");

  expect(result.capacityCuFt).toBeGreaterThanOrEqual(0);
  expect(result.effectiveCapacityCuFt).toBeGreaterThanOrEqual(0);
  expect(result.requiredCuFt).toBeGreaterThanOrEqual(0);

  // utilization should be finite even if capacity is zero (impl may clamp)
  expect(Number.isFinite(result.utilizationPct)).toBe(true);

  if (result.byDomain) {
    expect(typeof result.byDomain).toBe("object");
    Object.values(result.byDomain).forEach((bucket) => {
      expect(typeof bucket.requiredCuFt).toBe("number");
      expect(typeof bucket.utilizationPct).toBe("number");
      expect(bucket.requiredCuFt).toBeGreaterThanOrEqual(0);
    });
  }

  if (result.layoutHints) {
    expect(typeof result.layoutHints).toBe("object");
    if (Array.isArray(result.layoutHints.layerSuggestions)) {
      result.layoutHints.layerSuggestions.forEach((layer) => {
        expect(typeof layer.domainTag).toBe("string");
        expect(typeof layer.layerIndex).toBe("number");
        expect(typeof layer.approxCuFt).toBe("number");
      });
    }
  }

  if (result.warnings) {
    expect(Array.isArray(result.warnings)).toBe(true);
  }
}

// -----------------------------------------------------------------------------
// Basic behavior
// -----------------------------------------------------------------------------
describe("FreezerSpaceCalculator.calculateFreezerSpace – basic structure", () => {
  it("returns a well-formed object for a simple meat-only batch", () => {
    const result = calculateFreezerSpace({
      capacityCuFt: 15,
      items: [
        {
          name: "Ground beef 1 lb bricks",
          count: 30,
          volumePerUnitCuFt: 0.05,
          packagingShape: "box",
          stackable: true,
          domainTag: "meat"
        }
      ]
    });

    assertBaseShape(result);
    expect(result.capacityCuFt).toBeCloseTo(15, 5);
    expect(result.requiredCuFt).toBeGreaterThan(0);
    expect(result.byDomain.meat.requiredCuFt).toBeGreaterThan(0);
  });

  it("handles an empty item list without throwing", () => {
    const result = calculateFreezerSpace({
      capacityCuFt: 10,
      items: []
    });

    assertBaseShape(result);
    expect(result.requiredCuFt).toBe(0);
    expect(result.utilizationPct).toBe(0);
    expect(result.fits).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// Capacity & reservedPct
// -----------------------------------------------------------------------------
describe("FreezerSpaceCalculator.calculateFreezerSpace – capacity & reservations", () => {
  it("reduces effective capacity when reservedPct is set", () => {
    const noReserved = calculateFreezerSpace({
      capacityCuFt: 20,
      reservedPct: 0,
      items: [
        {
          name: "Mixed cuts",
          count: 40,
          volumePerUnitCuFt: 0.1,
          domainTag: "meat"
        }
      ]
    });

    const withReserved = calculateFreezerSpace({
      capacityCuFt: 20,
      reservedPct: 0.25,
      items: [
        {
          name: "Mixed cuts",
          count: 40,
          volumePerUnitCuFt: 0.1,
          domainTag: "meat"
        }
      ]
    });

    assertBaseShape(noReserved);
    assertBaseShape(withReserved);

    expect(withReserved.effectiveCapacityCuFt).toBeLessThan(
      noReserved.effectiveCapacityCuFt
    );
  });

  it("marks fits=false when requiredCuFt exceeds effectiveCapacityCuFt", () => {
    const result = calculateFreezerSpace({
      capacityCuFt: 5,
      reservedPct: 0.1,
      items: [
        {
          name: "Too many roasts",
          count: 100,
          volumePerUnitCuFt: 0.1,
          domainTag: "meat"
        }
      ]
    });

    assertBaseShape(result);
    expect(result.requiredCuFt).toBeGreaterThan(result.effectiveCapacityCuFt);
    expect(result.fits).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// Packaging & packing efficiency
// -----------------------------------------------------------------------------
describe("FreezerSpaceCalculator.calculateFreezerSpace – packaging & efficiency", () => {
  it("uses better packing for stackable boxes vs loose bags", () => {
    const boxes = calculateFreezerSpace({
      capacityCuFt: 15,
      items: [
        {
          name: "Box-packed meat",
          count: 20,
          volumePerUnitCuFt: 0.1,
          packagingShape: "box",
          stackable: true,
          domainTag: "meat"
        }
      ]
    });

    const bags = calculateFreezerSpace({
      capacityCuFt: 15,
      items: [
        {
          name: "Loose bags of meat",
          count: 20,
          volumePerUnitCuFt: 0.1,
          packagingShape: "bag",
          stackable: false,
          domainTag: "meat"
        }
      ]
    });

    assertBaseShape(boxes);
    assertBaseShape(bags);

    // For the same nominal item volume, bags should require more space
    expect(bags.requiredCuFt).toBeGreaterThanOrEqual(boxes.requiredCuFt);
  });

  it("respects custom packingEfficiency override when present", () => {
    const baseline = calculateFreezerSpace({
      capacityCuFt: 10,
      items: [
        {
          name: "Default packed",
          count: 10,
          volumePerUnitCuFt: 0.2,
          domainTag: "meat"
        }
      ]
    });

    const tighter = calculateFreezerSpace({
      capacityCuFt: 10,
      items: [
        {
          name: "Tightly packed",
          count: 10,
          volumePerUnitCuFt: 0.2,
          packingEfficiency: 0.95, // very efficient
          domainTag: "meat"
        }
      ]
    });

    assertBaseShape(baseline);
    assertBaseShape(tighter);

    expect(tighter.requiredCuFt).toBeLessThanOrEqual(baseline.requiredCuFt);
  });
});

// -----------------------------------------------------------------------------
// Liter vs cubic feet handling
// -----------------------------------------------------------------------------
describe("FreezerSpaceCalculator.calculateFreezerSpace – liters vs cubic feet", () => {
  it("converts volumePerUnitL to cubic feet internally", () => {
    // 1 cubic foot ≈ 28.3168 liters
    const byCuFt = calculateFreezerSpace({
      capacityCuFt: 10,
      items: [
        {
          name: "Soup bricks",
          count: 10,
          volumePerUnitCuFt: 1 / 28.3168,
          domainTag: "prepared"
        }
      ]
    });

    const byLiters = calculateFreezerSpace({
      capacityCuFt: 10,
      items: [
        {
          name: "Soup bricks",
          count: 10,
          volumePerUnitL: 1,
          domainTag: "prepared"
        }
      ]
    });

    assertBaseShape(byCuFt);
    assertBaseShape(byLiters);

    const ratio = byLiters.requiredCuFt / byCuFt.requiredCuFt;
    // Should be close enough to equal; allow some calculator wiggle (< 10% diff)
    expect(ratio).toBeGreaterThan(0.9);
    expect(ratio).toBeLessThan(1.1);
  });
});

// -----------------------------------------------------------------------------
// Domain breakdown
// -----------------------------------------------------------------------------
describe("FreezerSpaceCalculator.calculateFreezerSpace – domain breakdown", () => {
  it("groups required volume by domainTag for Planning Graph", () => {
    const result = calculateFreezerSpace({
      capacityCuFt: 20,
      items: [
        {
          name: "Beef cuts",
          count: 30,
          volumePerUnitCuFt: 0.08,
          domainTag: "meat"
        },
        {
          name: "Frozen veggies",
          count: 40,
          volumePerUnitCuFt: 0.03,
          domainTag: "veg"
        },
        {
          name: "Prepared meals",
          count: 15,
          volumePerUnitCuFt: 0.05,
          domainTag: "prepared"
        }
      ]
    });

    assertBaseShape(result);
    expect(result.byDomain).toBeTruthy();
    expect(result.byDomain.meat.requiredCuFt).toBeGreaterThan(0);
    expect(result.byDomain.veg.requiredCuFt).toBeGreaterThan(0);
    expect(result.byDomain.prepared.requiredCuFt).toBeGreaterThan(0);

    const sumDomains = Object.values(result.byDomain).reduce(
      (sum, bucket) => sum + bucket.requiredCuFt,
      0
    );

    // Allow mild rounding differences; domain sum should be close to total
    const ratio = sumDomains / result.requiredCuFt;
    expect(ratio).toBeGreaterThan(0.95);
    expect(ratio).toBeLessThan(1.05);
  });
});

// -----------------------------------------------------------------------------
// Defensive behavior
// -----------------------------------------------------------------------------
describe("FreezerSpaceCalculator.calculateFreezerSpace – defensive behavior", () => {
  it("handles negative or missing capacity by clamping and issuing warnings", () => {
    const result = calculateFreezerSpace({
      capacityCuFt: -5,
      items: [
        {
          name: "Mystery meat",
          count: 5,
          volumePerUnitCuFt: 0.1,
          domainTag: "meat"
        }
      ]
    });

    assertBaseShape(result);
    expect(result.capacityCuFt).toBeGreaterThanOrEqual(0);

    if (result.warnings && result.warnings.length > 0) {
      const joined = result.warnings.join(" ").toLowerCase();
      expect(joined).toContain("capacity");
    }
  });

  it("handles weird item counts or volumes without throwing", () => {
    const result = calculateFreezerSpace({
      capacityCuFt: 10,
      items: [
        {
          name: "Negative volume",
          count: -3,
          volumePerUnitCuFt: -0.5,
          domainTag: "meat"
        },
        {
          name: "NaN volume",
          count: 2,
          volumePerUnitCuFt: NaN,
          domainTag: "veg"
        }
      ]
    });

    assertBaseShape(result);
    expect(result.requiredCuFt).toBeGreaterThanOrEqual(0);

    if (result.warnings && result.warnings.length > 0) {
      const joined = result.warnings.join(" ").toLowerCase();
      expect(joined).toContain("volume");
    }
  });
});

// -----------------------------------------------------------------------------
// SSA / SessionRunner compatibility
// -----------------------------------------------------------------------------
describe("FreezerSpaceCalculator.calculateFreezerSpace – SSA compatibility checks", () => {
  it("returns values that can be used to generate storehouse sessions", () => {
    const result = calculateFreezerSpace({
      capacityCuFt: 18,
      reservedPct: 0.15,
      layout: { shelves: 4, baskets: 2, deepChest: true },
      items: [
        {
          name: "Butchered lamb",
          count: 25,
          volumePerUnitCuFt: 0.1,
          packagingShape: "box",
          stackable: true,
          domainTag: "meat"
        },
        {
          name: "Bone broth jars",
          count: 30,
          volumePerUnitCuFt: 0.03,
          packagingShape: "round",
          stackable: false,
          domainTag: "prepared"
        }
      ]
    });

    assertBaseShape(result);

    // For SSA session planning, we mainly need stable, finite numbers
    expect(Number.isFinite(result.requiredCuFt)).toBe(true);
    expect(Number.isFinite(result.effectiveCapacityCuFt)).toBe(true);
    expect(Number.isFinite(result.utilizationPct)).toBe(true);

    // Utilization should be a non-negative percentage
    expect(result.utilizationPct).toBeGreaterThanOrEqual(0);
  });
});
