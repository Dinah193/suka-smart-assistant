// C:\Users\larho\suka-smart-assistant\src\tests\calculators\storehouseMeals\RecipeScalingCalculator.test.js
// -----------------------------------------------------------------------------
// Unit tests for RecipeScalingCalculator logic.
//
// ASSUMED PUBLIC API (you can implement to match this):
//
//   import { scaleRecipe } from
//     "@/features/calculators/storehouseMeals/RecipeScalingCalculator.logic.js";
//
//   const result = scaleRecipe(config);
//
// Where `config` looks like:
//
//   {
//     baseServings: number,        // e.g. 4
//     targetServings: number,      // desired servings, must be > 0
//     ingredients: [
//       {
//         id?: string,
//         name: string,
//         quantity: number,        // base quantity for baseServings
//         unit: string,            // e.g. "g", "cup", "tsp", "clove"
//         scaleLock?: boolean,     // true = do not scale (e.g. "1 bay leaf")
//         minQty?: number,         // optional lower bound after scaling
//         maxQty?: number          // optional upper bound after scaling
//       }
//     ],
//     scalingMode?: "linear" | "ceiling" | "floor",  // OPTIONAL
//     rounding?: {                                  // OPTIONAL
//       mode?: "none" | "fraction" | "decimal",
//       step?: number                               // e.g. 0.25, 0.5, 1
//     }
//   }
//
// And `scaleRecipe(config)` returns:
//
//   {
//     baseServings: number,
//     targetServings: number,
//     scaleFactor: number,               // targetServings / baseServings
//     ingredients: [
//       {
//         id?: string,
//         name: string,
//         unit: string,
//         quantity: number,              // scaled and rounded quantity
//         originalQuantity: number,      // original base quantity
//         minQty?: number,
//         maxQty?: number,
//         scaleLock?: boolean,
//         notes?: string[]               // OPTIONAL per-ingredient notes
//       }
//     ],
//     warnings?: string[],               // OPTIONAL: global warnings
//     notes?: string[]                   // OPTIONAL: global notes
//   }
//
// These tests emphasize relationships and sane behavior, not one brittle
// exact formula. You can iterate on the implementation without breaking
// SSA integration as long as these expectations stay true.
// -----------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import { scaleRecipe } from "@/features/calculators/storehouseMeals/RecipeScalingCalculator.logic.js";

const BASE_CONFIG = Object.freeze({
  baseServings: 4,
  targetServings: 8,
  ingredients: [
    { name: "Flour", quantity: 200, unit: "g" },       // 200g for 4 servings
    { name: "Sugar", quantity: 50, unit: "g" },        // 50g for 4 servings
    { name: "Salt", quantity: 0.5, unit: "tsp" },      // 0.5 tsp for 4 servings
    { name: "Eggs", quantity: 2, unit: "piece" }       // 2 eggs for 4 servings
  ]
});

// Simple helper to find ingredient by name
function byName(list, name) {
  return list.find((i) => i.name === name);
}

describe("RecipeScalingCalculator.scaleRecipe – basic structure", () => {
  it("returns an object with expected top-level fields", () => {
    const result = scaleRecipe(BASE_CONFIG);

    expect(result).toBeTruthy();
    expect(typeof result).toBe("object");

    expect(result.baseServings).toBe(BASE_CONFIG.baseServings);
    expect(result.targetServings).toBe(BASE_CONFIG.targetServings);
    expect(typeof result.scaleFactor).toBe("number");
    expect(Array.isArray(result.ingredients)).toBe(true);

    // Sanity checks on numbers
    expect(result.baseServings).toBeGreaterThan(0);
    expect(result.targetServings).toBeGreaterThan(0);
    expect(result.scaleFactor).toBeGreaterThan(0);
  });

  it("includes originalQuantity and scaled quantity for each ingredient", () => {
    const result = scaleRecipe(BASE_CONFIG);

    result.ingredients.forEach((ing) => {
      expect(typeof ing.name).toBe("string");
      expect(typeof ing.unit).toBe("string");
      expect(typeof ing.quantity).toBe("number");
      expect(typeof ing.originalQuantity).toBe("number");

      // quantity should be positive for these base samples
      expect(ing.quantity).toBeGreaterThan(0);
      expect(ing.originalQuantity).toBeGreaterThan(0);
    });
  });

  it("uses scaleFactor ≈ targetServings / baseServings", () => {
    const config = {
      baseServings: 4,
      targetServings: 10,
      ingredients: BASE_CONFIG.ingredients
    };

    const expectedScale = config.targetServings / config.baseServings;
    const result = scaleRecipe(config);

    const diff = Math.abs(result.scaleFactor - expectedScale);
    expect(diff).toBeLessThan(0.0001);
  });
});

describe("RecipeScalingCalculator.scaleRecipe – linear scaling behavior", () => {
  it("scales ingredient quantities linearly for default mode", () => {
    const result = scaleRecipe(BASE_CONFIG); // 4 -> 8 servings => scale x2

    const flour = byName(result.ingredients, "Flour");
    const sugar = byName(result.ingredients, "Sugar");
    const salt = byName(result.ingredients, "Salt");
    const eggs = byName(result.ingredients, "Eggs");

    expect(flour.quantity).toBeCloseTo(400, 5); // 200 * 2
    expect(sugar.quantity).toBeCloseTo(100, 5); // 50 * 2
    expect(salt.quantity).toBeCloseTo(1.0, 5);  // 0.5 * 2
    expect(eggs.quantity).toBeCloseTo(4, 5);    // 2 * 2
  });

  it("handles down-scaling correctly (more than one serving)", () => {
    const config = {
      baseServings: 8,
      targetServings: 2,
      ingredients: [
        { name: "Rice", quantity: 400, unit: "g" }, // 400g for 8
        { name: "Water", quantity: 800, unit: "ml" }
      ]
    };

    const result = scaleRecipe(config);
    const rice = byName(result.ingredients, "Rice");
    const water = byName(result.ingredients, "Water");

    // Scale = 2/8 = 0.25
    expect(rice.quantity).toBeCloseTo(100, 5);
    expect(water.quantity).toBeCloseTo(200, 5);
  });
});

describe("RecipeScalingCalculator.scaleRecipe – scaleLock and caps", () => {
  it("honors scaleLock (ingredient not scaled)", () => {
    const config = {
      baseServings: 4,
      targetServings: 8,
      ingredients: [
        { name: "Flour", quantity: 200, unit: "g" },
        { name: "Bay leaf", quantity: 1, unit: "leaf", scaleLock: true }
      ]
    };

    const result = scaleRecipe(config);
    const flour = byName(result.ingredients, "Flour");
    const bayLeaf = byName(result.ingredients, "Bay leaf");

    expect(flour.quantity).toBeCloseTo(400, 5); // scaled
    expect(bayLeaf.quantity).toBeCloseTo(1, 5); // not scaled
    expect(bayLeaf.scaleLock).toBe(true);
  });

  it("applies minQty and maxQty bounds per ingredient when provided", () => {
    const config = {
      baseServings: 2,
      targetServings: 10, // large scale up
      ingredients: [
        {
          name: "Salt",
          quantity: 0.5,
          unit: "tsp",
          minQty: 0.5,
          maxQty: 2.0
        }
      ]
    };

    const result = scaleRecipe(config);
    const salt = byName(result.ingredients, "Salt");

    // Raw linear scale would be 0.5 * 5 = 2.5 tsp
    // With maxQty 2.0, we expect it to be clamped
    expect(salt.quantity).toBeLessThanOrEqual(2.0 + 1e-6);
    expect(salt.quantity).toBeGreaterThanOrEqual(0.5 - 1e-6);
  });
});

describe("RecipeScalingCalculator.scaleRecipe – rounding behavior", () => {
  it("supports fractional rounding (e.g. quarters)", () => {
    const config = {
      baseServings: 4,
      targetServings: 3,
      ingredients: [
        { name: "Butter", quantity: 3, unit: "tbsp" } // 3 tbsp for 4
      ],
      rounding: {
        mode: "fraction",
        step: 0.25
      }
    };

    const result = scaleRecipe(config);

    // Raw linear: 3 * (3/4) = 2.25 tbsp
    const butter = byName(result.ingredients, "Butter");
    expect(butter.quantity).toBeCloseTo(2.25, 5);
  });

  it("supports decimal rounding with a given step", () => {
    const config = {
      baseServings: 4,
      targetServings: 3,
      ingredients: [
        { name: "Oil", quantity: 10, unit: "ml" } // 10 ml for 4
      ],
      rounding: {
        mode: "decimal",
        step: 0.1
      }
    };

    const result = scaleRecipe(config);
    const oil = byName(result.ingredients, "Oil");

    // Raw linear: 10 * (3/4) = 7.5 ml
    // With decimal step 0.1, this likely stays 7.5 but
    // the test mainly ensures it's close AND not some wild
    // extra rounding error.
    expect(oil.quantity).toBeCloseTo(7.5, 5);
  });

  it("allows rounding mode 'none' for exact scaling", () => {
    const config = {
      baseServings: 3,
      targetServings: 5,
      ingredients: [
        { name: "Yeast", quantity: 7, unit: "g" } // 7g for 3
      ],
      rounding: {
        mode: "none"
      }
    };

    const result = scaleRecipe(config);
    const yeast = byName(result.ingredients, "Yeast");

    const expectedRaw = 7 * (5 / 3);
    expect(yeast.quantity).toBeCloseTo(expectedRaw, 7);
  });
});

describe("RecipeScalingCalculator.scaleRecipe – scaling modes", () => {
  it("treats scalingMode=linear as pure proportional scaling", () => {
    const config = {
      baseServings: 4,
      targetServings: 6,
      scalingMode: "linear",
      ingredients: [
        { name: "Milk", quantity: 400, unit: "ml" } // 400 ml for 4
      ]
    };

    const result = scaleRecipe(config);
    const milk = byName(result.ingredients, "Milk");

    const expected = 400 * (6 / 4); // 600 ml
    expect(milk.quantity).toBeCloseTo(expected, 5);
  });

  it("with scalingMode=ceiling can round ingredient quantities up per-step", () => {
    const config = {
      baseServings: 4,
      targetServings: 5,
      scalingMode: "ceiling",
      rounding: {
        mode: "decimal",
        step: 0.1
      },
      ingredients: [
        { name: "Eggs", quantity: 2, unit: "piece" } // 2 eggs for 4
      ]
    };

    const result = scaleRecipe(config);
    const eggs = byName(result.ingredients, "Eggs");

    // Raw linear: 2 * (5/4) = 2.5 eggs
    // With "ceiling", we expect >= 2.5 (likely 3)
    expect(eggs.quantity).toBeGreaterThanOrEqual(2.5 - 1e-6);
  });

  it("with scalingMode=floor can round ingredient quantities down", () => {
    const config = {
      baseServings: 4,
      targetServings: 5,
      scalingMode: "floor",
      rounding: {
        mode: "decimal",
        step: 0.1
      },
      ingredients: [
        { name: "Eggs", quantity: 2, unit: "piece" }
      ]
    };

    const result = scaleRecipe(config);
    const eggs = byName(result.ingredients, "Eggs");

    // Raw linear: 2 * (5/4) = 2.5 eggs
    // With "floor", we expect <= 2.5
    expect(eggs.quantity).toBeLessThanOrEqual(2.5 + 1e-6);
  });
});

describe("RecipeScalingCalculator.scaleRecipe – invalid inputs and guard rails", () => {
  it("throws or returns a clearly invalid result when baseServings or targetServings are <= 0", () => {
    const badConfigs = [
      { baseServings: 0, targetServings: 4, ingredients: BASE_CONFIG.ingredients },
      { baseServings: 4, targetServings: 0, ingredients: BASE_CONFIG.ingredients },
      { baseServings: -2, targetServings: 4, ingredients: BASE_CONFIG.ingredients },
      { baseServings: 4, targetServings: -5, ingredients: BASE_CONFIG.ingredients }
    ];

    badConfigs.forEach((config) => {
      let threw = false;
      let result = undefined;

      try {
        result = scaleRecipe(config);
      } catch (err) {
        threw = true;
      }

      if (!threw) {
        // If it did not throw, ensure result does NOT look like a valid scaling.
        const looksValid =
          result &&
          typeof result === "object" &&
          typeof result.baseServings === "number" &&
          typeof result.targetServings === "number" &&
          result.baseServings > 0 &&
          result.targetServings > 0 &&
          typeof result.scaleFactor === "number" &&
          result.scaleFactor > 0;

        expect(looksValid).toBe(false);
      }
    });
  });

  it("handles empty ingredients array gracefully", () => {
    const config = {
      baseServings: 4,
      targetServings: 8,
      ingredients: []
    };

    const result = scaleRecipe(config);
    expect(Array.isArray(result.ingredients)).toBe(true);
    expect(result.ingredients.length).toBe(0);
  });

  it("handles null/undefined ingredient entries defensively", () => {
    const config = {
      baseServings: 4,
      targetServings: 8,
      ingredients: [
        { name: "Flour", quantity: 200, unit: "g" },
        null,
        undefined
      ]
    };

    const result = scaleRecipe(config);
    // We expect only the valid ingredient to come through
    expect(result.ingredients.length).toBe(1);
    const flour = byName(result.ingredients, "Flour");
    expect(flour).toBeTruthy();
    expect(flour.quantity).toBeCloseTo(400, 5);
  });
});

describe("RecipeScalingCalculator.scaleRecipe – notes and warnings for SSA integration", () => {
  it("can emit warnings when min/max clamps or scaleLock significantly change quantities", () => {
    const config = {
      baseServings: 2,
      targetServings: 20,
      ingredients: [
        {
          name: "Salt",
          quantity: 0.25,
          unit: "tsp",
          minQty: 0.25,
          maxQty: 1.0
        },
        {
          name: "Chili flakes",
          quantity: 0.5,
          unit: "tsp",
          scaleLock: true
        }
      ]
    };

    const result = scaleRecipe(config);
    const salt = byName(result.ingredients, "Salt");
    const chili = byName(result.ingredients, "Chili flakes");

    expect(salt.quantity).toBeLessThanOrEqual(1.0 + 1e-6);
    expect(chili.quantity).toBeCloseTo(0.5, 5);

    // If warnings are present, they should be an array of strings
    if (result.warnings) {
      expect(Array.isArray(result.warnings)).toBe(true);
      result.warnings.forEach((w) => expect(typeof w).toBe("string"));
    }
  });

  it("keeps scaleFactor stable for use in SessionRunner and Planning Graph", () => {
    const config = {
      baseServings: 6,
      targetServings: 9,
      ingredients: [
        { name: "Pasta", quantity: 600, unit: "g" }
      ]
    };

    const result = scaleRecipe(config);
    const expectedScale = 9 / 6;

    expect(result.scaleFactor).toBeCloseTo(expectedScale, 5);

    // This ratio is important downstream to:
    // - derive cook-time adjustments,
    // - derive storehouse depletion,
    // - align with SessionRunner steps for multi-batch cooking.
  });
});
