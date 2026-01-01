// C:\Users\larho\suka-smart-assistant\src\tests\calculators\storehouseMeals\CostPerServingCalculator.test.js
// -----------------------------------------------------------------------------
// Unit tests for CostPerServingCalculator logic.
//
// ASSUMED PUBLIC API (align your implementation to this shape):
//
//   import { calculateCostPerServing } from
//     "@/features/calculators/storehouseMeals/CostPerServingCalculator.logic.js";
//
//   const result = calculateCostPerServing(config);
//
// Where `config` looks like:
//
//   {
//     currency: "USD" | "EUR" | string,
//     // Optional grouping key for comparisons (e.g. "name" or "normalizedName")
//     groupBy?: "name" | "normalizedName" | "category" | string,
//     items: [
//       {
//         id?: string,
//         name: string,
//         normalizedName?: string,  // optional, for grouping cross-store variants
//         brand?: string,
//         store?: string,
//         unitLabel: string,        // e.g. "oz", "lb", "kg", "can", "jar"
//         unitSize: number,         // e.g. 16 (oz), 5 (lb), etc.
//         unitPrice: number,        // price for the package (not per-unit)
//         servingsPerUnit: number,  // how many servings per entire package
//         wasteFactor?: number,     // 0–1, portion lost to trimming/spoilage
//         tags?: string[]
//       }
//     ]
//   }
//
// And `calculateCostPerServing(config)` returns:
//
//   {
//     currency: string,
//     items: [
//       {
//         id?: string,
//         name: string,
//         normalizedName?: string,
//         brand?: string,
//         store?: string,
//         unitLabel: string,
//         unitSize: number,
//         unitPrice: number,
//         servingsPerUnit: number,
//         wasteFactor: number,      // normalized to 0–1
//
//         effectiveServings: number, // servingsPerUnit * (1 - wasteFactor)
//         costPerUnit: number,       // same as unitPrice
//         costPerServing: number,    // unitPrice / effectiveServings
//
//         // Optional helper fields for SSA UI / Planning Graph:
//         groupKey?: string,         // derived from groupBy
//         isCheapestInGroup?: boolean,
//         notes?: string[]
//       }
//     ],
//     groups?: [
//       {
//         key: string,              // groupKey
//         label: string,            // human label, e.g. first name or category
//         cheapestItemId?: string,  // if any ids
//         cheapestCostPerServing: number,
//         itemCount: number
//       }
//     ],
//     warnings?: string[]
//   }
//
// These tests focus on:
//   * Correct cost-per-serving math, including wasteFactor
//   * Stable structure and numeric fields
//   * Group comparisons and cheapest option detection
//   * Defensive handling of invalid inputs
//   * Reasonable warnings for extreme / broken data
//
// SSA will use this calculator to:
//   * Compare brands/stores for the same staple
//   * Feed Storehouse + Planning Graph nodes with normalized cost data
//   * Provide insight to SessionRunner for budget-aware session suggestions
// -----------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import { calculateCostPerServing } from "@/features/calculators/storehouseMeals/CostPerServingCalculator.logic.js";

const BASE_CONFIG = Object.freeze({
  currency: "USD",
  groupBy: "normalizedName",
  items: [
    {
      id: "rice_store_a",
      name: "Long Grain White Rice 5lb",
      normalizedName: "long-grain-rice",
      brand: "Store A",
      store: "Store A",
      unitLabel: "lb",
      unitSize: 5,
      unitPrice: 6.0,        // $6 per 5 lb bag
      servingsPerUnit: 50,   // 50 servings per bag
      wasteFactor: 0.0,
      tags: ["staple", "grain"]
    },
    {
      id: "rice_store_b",
      name: "Long Grain Rice 10lb",
      normalizedName: "long-grain-rice",
      brand: "Store B",
      store: "Store B",
      unitLabel: "lb",
      unitSize: 10,
      unitPrice: 11.0,       // $11 per 10 lb bag
      servingsPerUnit: 100,  // 100 servings
      wasteFactor: 0.0,
      tags: ["staple", "grain"]
    },
    {
      id: "oats_store_a",
      name: "Rolled Oats 2lb",
      normalizedName: "rolled-oats",
      brand: "Store A",
      store: "Store A",
      unitLabel: "lb",
      unitSize: 2,
      unitPrice: 3.5,
      servingsPerUnit: 20,
      wasteFactor: 0.1,
      tags: ["breakfast", "grain"]
    }
  ]
});

function byId(items, id) {
  return items.find((i) => i.id === id);
}

function byName(items, name) {
  return items.find((i) => i.name === name);
}

// -----------------------------------------------------------------------------
// Basic structure
// -----------------------------------------------------------------------------
describe("CostPerServingCalculator.calculateCostPerServing – basic structure", () => {
  it("returns expected top-level fields", () => {
    const result = calculateCostPerServing(BASE_CONFIG);

    expect(result).toBeTruthy();
    expect(typeof result).toBe("object");

    expect(result.currency).toBe("USD");
    expect(Array.isArray(result.items)).toBe(true);
    expect(result.items.length).toBe(BASE_CONFIG.items.length);

    if (result.groups) {
      expect(Array.isArray(result.groups)).toBe(true);
    }
    if (result.warnings) {
      expect(Array.isArray(result.warnings)).toBe(true);
    }
  });

  it("mirrors input items and adds derived numeric fields", () => {
    const result = calculateCostPerServing(BASE_CONFIG);

    result.items.forEach((item, idx) => {
      const input = BASE_CONFIG.items[idx];

      expect(item.name).toBe(input.name);
      expect(item.unitLabel).toBe(input.unitLabel);
      expect(item.unitSize).toBeCloseTo(input.unitSize, 6);
      expect(item.unitPrice).toBeCloseTo(input.unitPrice, 6);
      expect(item.servingsPerUnit).toBeCloseTo(input.servingsPerUnit, 6);

      expect(typeof item.wasteFactor).toBe("number");
      expect(typeof item.effectiveServings).toBe("number");
      expect(typeof item.costPerUnit).toBe("number");
      expect(typeof item.costPerServing).toBe("number");
    });
  });
});

// -----------------------------------------------------------------------------
// Core math
// -----------------------------------------------------------------------------
describe("CostPerServingCalculator.calculateCostPerServing – core math", () => {
  it("computes effectiveServings as servingsPerUnit * (1 - wasteFactor)", () => {
    const result = calculateCostPerServing(BASE_CONFIG);

    BASE_CONFIG.items.forEach((input) => {
      const item = byId(result.items, input.id);
      const waste = input.wasteFactor == null ? 0 : input.wasteFactor;
      const expectedEffective = input.servingsPerUnit * (1 - waste);
      expect(item.effectiveServings).toBeCloseTo(expectedEffective, 6);
    });
  });

  it("treats missing wasteFactor as 0", () => {
    const config = {
      currency: "USD",
      items: [
        {
          id: "test_no_waste",
          name: "Test Food",
          normalizedName: "test-food",
          unitLabel: "oz",
          unitSize: 16,
          unitPrice: 4.0,
          servingsPerUnit: 8
          // no wasteFactor
        }
      ]
    };

    const result = calculateCostPerServing(config);
    const item = byId(result.items, "test_no_waste");

    expect(item.wasteFactor).toBeCloseTo(0, 6);
    expect(item.effectiveServings).toBeCloseTo(8, 6);
  });

  it("computes costPerUnit equal to unitPrice", () => {
    const result = calculateCostPerServing(BASE_CONFIG);

    BASE_CONFIG.items.forEach((input) => {
      const item = byId(result.items, input.id);
      expect(item.costPerUnit).toBeCloseTo(input.unitPrice, 6);
    });
  });

  it("computes costPerServing as unitPrice / effectiveServings", () => {
    const result = calculateCostPerServing(BASE_CONFIG);

    BASE_CONFIG.items.forEach((input) => {
      const item = byId(result.items, input.id);
      const waste = input.wasteFactor == null ? 0 : input.wasteFactor;
      const effectiveServings = input.servingsPerUnit * (1 - waste);
      const expectedCostPerServing = effectiveServings > 0
        ? input.unitPrice / effectiveServings
        : Infinity;

      if (effectiveServings > 0) {
        expect(item.costPerServing).toBeCloseTo(expectedCostPerServing, 6);
      } else {
        // If effectiveServings is 0 or less, we just expect a non-negative sentinel
        expect(item.costPerServing).toBeGreaterThanOrEqual(0);
      }
    });
  });

  it("adjusts costPerServing appropriately when waste increases", () => {
    const baseItem = {
      id: "waste_test",
      name: "Chicken Thighs",
      normalizedName: "chicken-thighs",
      unitLabel: "lb",
      unitSize: 5,
      unitPrice: 10.0,
      servingsPerUnit: 20
    };

    const lowWasteConfig = {
      currency: "USD",
      items: [
        { ...baseItem, wasteFactor: 0.05 } // 5% waste
      ]
    };

    const highWasteConfig = {
      currency: "USD",
      items: [
        { ...baseItem, wasteFactor: 0.25 } // 25% waste
      ]
    };

    const lowResult = calculateCostPerServing(lowWasteConfig);
    const highResult = calculateCostPerServing(highWasteConfig);

    const low = byId(lowResult.items, "waste_test");
    const high = byId(highResult.items, "waste_test");

    expect(low.costPerServing).toBeLessThan(high.costPerServing);
  });
});

// -----------------------------------------------------------------------------
// Grouping and cheapest selection
// -----------------------------------------------------------------------------
describe("CostPerServingCalculator.calculateCostPerServing – grouping & cheapest in group", () => {
  it("groups by normalizedName and identifies cheapest per group", () => {
    const result = calculateCostPerServing(BASE_CONFIG);

    // We expect a group for "long-grain-rice"
    const riceGroup = result.groups
      ? result.groups.find((g) => g.key === "long-grain-rice")
      : undefined;

    expect(riceGroup).toBeTruthy();
    expect(riceGroup.itemCount).toBe(2);

    const riceA = byId(result.items, "rice_store_a");
    const riceB = byId(result.items, "rice_store_b");

    // Both configurations are:
    //   rice_store_a: $6 / (50 servings)  = 0.12 / serving
    //   rice_store_b: $11 / (100 servings) = 0.11 / serving
    expect(riceA.costPerServing).toBeCloseTo(0.12, 2);
    expect(riceB.costPerServing).toBeCloseTo(0.11, 2);
    expect(riceB.costPerServing).toBeLessThan(riceA.costPerServing);

    // Cheaper one should be flagged
    expect(riceB.isCheapestInGroup).toBe(true);
    expect(riceA.isCheapestInGroup).not.toBe(true);

    if (riceGroup.cheapestItemId) {
      expect(riceGroup.cheapestItemId).toBe("rice_store_b");
      expect(riceGroup.cheapestCostPerServing).toBeCloseTo(
        riceB.costPerServing,
        6
      );
    }
  });

  it("handles single-item groups without marking invalid cheapest flags", () => {
    const config = {
      currency: "USD",
      groupBy: "normalizedName",
      items: [
        {
          id: "only_one",
          name: "Sea Salt",
          normalizedName: "sea-salt",
          unitLabel: "lb",
          unitSize: 3,
          unitPrice: 4.5,
          servingsPerUnit: 100,
          wasteFactor: 0
        }
      ]
    };

    const result = calculateCostPerServing(config);
    const group = result.groups ? result.groups[0] : undefined;

    expect(group).toBeTruthy();
    expect(group.key).toBe("sea-salt");
    expect(group.itemCount).toBe(1);

    const item = byId(result.items, "only_one");

    // Implementation may choose to mark it as cheapest by default
    // or skip the flag. We only assert that the field is not contradictory.
    if (item.isCheapestInGroup != null) {
      expect(typeof item.isCheapestInGroup).toBe("boolean");
    }
  });
});

// -----------------------------------------------------------------------------
// Invalid input handling
// -----------------------------------------------------------------------------
describe("CostPerServingCalculator.calculateCostPerServing – invalid inputs", () => {
  it("handles zero or negative servingsPerUnit defensively", () => {
    const config = {
      currency: "USD",
      items: [
        {
          id: "bad_servings",
          name: "Mystery Food",
          normalizedName: "mystery-food",
          unitLabel: "unit",
          unitSize: 1,
          unitPrice: 10,
          servingsPerUnit: 0, // invalid
          wasteFactor: 0
        }
      ]
    };

    const result = calculateCostPerServing(config);
    const item = byId(result.items, "bad_servings");

    // Implementation may set costPerServing to Infinity, 0, or some sentinel.
    // We only assert it's non-negative and that a warning may be present.
    expect(item.costPerServing).toBeGreaterThanOrEqual(0);

    if (result.warnings && result.warnings.length > 0) {
      const joined = result.warnings.join(" ");
      expect(joined.toLowerCase()).toContain("servings");
    }
  });

  it("handles wasteFactor outside 0–1 range by clamping or warning", () => {
    const config = {
      currency: "USD",
      items: [
        {
          id: "too_much_waste",
          name: "Trimmed Steak",
          normalizedName: "trimmed-steak",
          unitLabel: "lb",
          unitSize: 2,
          unitPrice: 20,
          servingsPerUnit: 8,
          wasteFactor: 1.5 // invalid, > 1
        }
      ]
    };

    const result = calculateCostPerServing(config);
    const item = byId(result.items, "too_much_waste");

    // Implementation should clamp to [0, 1] or otherwise keep it non-negative.
    expect(item.wasteFactor).toBeGreaterThanOrEqual(0);
    expect(item.wasteFactor).toBeLessThanOrEqual(1);

    if (result.warnings && result.warnings.length > 0) {
      const text = result.warnings.join(" ").toLowerCase();
      expect(text).toContain("waste");
    }
  });

  it("handles negative or zero prices with warnings", () => {
    const config = {
      currency: "USD",
      items: [
        {
          id: "free_food",
          name: "Free Sample",
          normalizedName: "free-sample",
          unitLabel: "unit",
          unitSize: 1,
          unitPrice: 0,
          servingsPerUnit: 1,
          wasteFactor: 0
        },
        {
          id: "negative_price",
          name: "Buggy Data",
          normalizedName: "buggy-data",
          unitLabel: "unit",
          unitSize: 1,
          unitPrice: -5,
          servingsPerUnit: 1,
          wasteFactor: 0
        }
      ]
    };

    const result = calculateCostPerServing(config);
    const freeFood = byId(result.items, "free_food");
    const buggy = byId(result.items, "negative_price");

    expect(freeFood.costPerServing).toBeGreaterThanOrEqual(0);
    expect(buggy.costPerServing).toBeGreaterThanOrEqual(0);

    if (result.warnings && result.warnings.length > 0) {
      const text = result.warnings.join(" ").toLowerCase();
      expect(text).toContain("price");
    }
  });

  it("handles empty items array gracefully", () => {
    const config = {
      currency: "USD",
      items: []
    };

    const result = calculateCostPerServing(config);

    expect(Array.isArray(result.items)).toBe(true);
    expect(result.items.length).toBe(0);

    if (result.groups) {
      expect(result.groups.length).toBe(0);
    }
  });
});

// -----------------------------------------------------------------------------
// SSA / Planning Graph compatibility
// -----------------------------------------------------------------------------
describe("CostPerServingCalculator.calculateCostPerServing – SSA compatibility", () => {
  it("produces stable data useful for Planning Graph + Storehouse refills", () => {
    const config = {
      currency: "USD",
      groupBy: "normalizedName",
      items: [
        {
          id: "lentils_a",
          name: "Brown Lentils 2lb",
          normalizedName: "brown-lentils",
          unitLabel: "lb",
          unitSize: 2,
          unitPrice: 3.0,
          servingsPerUnit: 16,
          wasteFactor: 0.02
        },
        {
          id: "lentils_b",
          name: "Brown Lentils 4lb",
          normalizedName: "brown-lentils",
          unitLabel: "lb",
          unitSize: 4,
          unitPrice: 5.0,
          servingsPerUnit: 32,
          wasteFactor: 0.02
        }
      ]
    };

    const result = calculateCostPerServing(config);

    // Ensure both items are comparable and have costPerServing computed.
    const a = byId(result.items, "lentils_a");
    const b = byId(result.items, "lentils_b");

    expect(a.costPerServing).toBeGreaterThan(0);
    expect(b.costPerServing).toBeGreaterThan(0);

    // Larger, cheaper bag should be more cost effective
    expect(b.costPerServing).toBeLessThan(a.costPerServing);

    // Group must reflect that fact for Planner / SessionRunner integration
    const group = result.groups
      ? result.groups.find((g) => g.key === "brown-lentils")
      : undefined;

    expect(group).toBeTruthy();
    expect(group.itemCount).toBe(2);

    if (group.cheapestItemId) {
      expect(group.cheapestItemId).toBe("lentils_b");
      expect(group.cheapestCostPerServing).toBeCloseTo(
        b.costPerServing,
        6
      );
    }
  });
});
