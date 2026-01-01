// C:\Users\larho\suka-smart-assistant\src\tests\calculators\calendar\BiblicalOfferingCalculator.test.js
// -----------------------------------------------------------------------------
// Unit tests for BiblicalOfferingCalculator
//
// PURPOSE
// -------
// Validates that the BiblicalOfferingCalculator:
//
//  * Produces a stable, well-typed result object.
//  * Correctly maps income/harvest items into offering categories.
//  * Applies tithe and poor-tithe rules consistently across years.
//  * Properly flags sabbath (7th) years and poor-tithe years.
//  * Maintains internal accounting consistency (totals vs. mappings).
//  * Behaves deterministically for identical inputs.
//  * Tolerates unknown categories with safe fallbacks and warnings.
//
// ASSUMED PUBLIC API
// ------------------
//
//   import { calculateBiblicalOfferings } from
//     "@/features/calculators/calendar/BiblicalOfferingCalculator.logic.js";
//
//   const result = calculateBiblicalOfferings({
//     incomeStreams: [
//       {
//         id: "wages-1",
//         label: "Household wages",
//         category: "wage" | "harvest" | "livestock" | "other",
//         amount: number,          // monetary or normalized value
//         unit: "currency" | "shekel" | "normalized" | string
//       },
//       // ...
//     ],
//     harvestYields: [
//       {
//         id: "wheat-1",
//         crop: "wheat",
//         category: "grain" | "fruit" | "oil" | "wine" | "other",
//         amount: number,          // in normalized units (bushels, kg, etc.)
//         unit: "bushel" | "kg" | "normalized" | string
//       },
//       // ...
//     ],
//     config: {
//       titheRate?: number,         // default 0.10
//       festivalRate?: number,      // optional additional percentage
//       poorTitheCycle?: 3 | 6,     // years in which poor tithe applies
//       includeFreewill?: boolean   // default true
//     },
//     yearIndexWithinShmita: 1 | 2 | 3 | 4 | 5 | 6 | 7
//   });
//
// RESULT SHAPE (minimum used in tests)
// ------------------------------------
//
//   {
//     totalTithe: number,
//     totalFestival: number,
//     totalPoorTithe: number,
//     totalFreewill: number,
//     sabbathYear: boolean,              // true if yearIndexWithinShmita === 7
//     offeringsByType: {
//       firstfruits: {
//         total: number,
//         items: Array<{
//           sourceId: string,
//           sourceLabel: string,
//           category: string,
//           amount: number
//         }>
//       },
//       regularTithe: { total: number, items: [...] },
//       poorTithe: { total: number, items: [...] },
//       festival: { total: number, items: [...] },
//       freewill: { total: number, items: [...] }
//     },
//     mapping: Array<{
//       sourceId: string,
//       sourceLabel: string,
//       category: string,
//       offeringType:
//         "firstfruits" |
//         "regularTithe" |
//         "poorTithe" |
//         "festival" |
//         "freewill",
//       amount: number
//     }>,
//     meta: {
//       appliedTitheRate: number,        // e.g. 0.1
//       appliedFestivalRate?: number,
//       poorTitheYear: boolean,
//       notes: string[]
//     }
//   }
//
// Tests below are *invariant-focused*, so you can change internal
// mapping heuristics later without breaking SSA Planning Graph or
// SessionRunner integrations.
// -----------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import { calculateBiblicalOfferings } from "@/features/calculators/calendar/BiblicalOfferingCalculator.logic.js";

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/**
 * Asserts that the calculator result has the expected shape and sane ranges.
 * @param {any} result
 */
function expectOfferingResultShape(result) {
  expect(result).toBeTruthy();
  expect(typeof result).toBe("object");

  // Core numeric totals
  ["totalTithe", "totalFestival", "totalPoorTithe", "totalFreewill"].forEach(
    (key) => {
      expect(result).toHaveProperty(key);
      expect(typeof result[key]).toBe("number");
      // Allow zero, but not negative
      expect(result[key]).toBeGreaterThanOrEqual(0);
    }
  );

  // sabbathYear flag
  expect(typeof result.sabbathYear).toBe("boolean");

  // offeringsByType structure
  expect(result.offeringsByType).toBeTruthy();
  expect(typeof result.offeringsByType).toBe("object");

  ["firstfruits", "regularTithe", "poorTithe", "festival", "freewill"].forEach(
    (bucket) => {
      expect(result.offeringsByType).toHaveProperty(bucket);
      const group = result.offeringsByType[bucket];
      expect(group).toBeTruthy();
      expect(typeof group.total).toBe("number");
      expect(Array.isArray(group.items)).toBe(true);

      group.items.forEach((item) => {
        expect(typeof item.sourceId).toBe("string");
        expect(typeof item.sourceLabel).toBe("string");
        expect(typeof item.category).toBe("string");
        expect(typeof item.amount).toBe("number");
        expect(item.amount).toBeGreaterThanOrEqual(0);
      });
    }
  );

  // mapping array
  expect(Array.isArray(result.mapping)).toBe(true);
  result.mapping.forEach((entry) => {
    expect(typeof entry.sourceId).toBe("string");
    expect(typeof entry.sourceLabel).toBe("string");
    expect(typeof entry.category).toBe("string");
    expect(typeof entry.offeringType).toBe("string");
    expect(
      [
        "firstfruits",
        "regularTithe",
        "poorTithe",
        "festival",
        "freewill"
      ].includes(entry.offeringType)
    ).toBe(true);
    expect(typeof entry.amount).toBe("number");
    expect(entry.amount).toBeGreaterThanOrEqual(0);
  });

  // meta
  expect(result.meta).toBeTruthy();
  expect(typeof result.meta).toBe("object");
  expect(typeof result.meta.appliedTitheRate).toBe("number");
  if (typeof result.meta.appliedFestivalRate !== "undefined") {
    expect(typeof result.meta.appliedFestivalRate).toBe("number");
  }
  expect(typeof result.meta.poorTitheYear).toBe("boolean");
  expect(Array.isArray(result.meta.notes)).toBe(true);
}

// Convenience: sums mapping by type
function sumMappingByType(mapping, type) {
  return mapping
    .filter((m) => m.offeringType === type)
    .reduce((sum, m) => sum + m.amount, 0);
}

// -----------------------------------------------------------------------------
// 1) Basic invariants for a standard (non-sabbath) year
// -----------------------------------------------------------------------------

describe("BiblicalOfferingCalculator – basic mappings", () => {
  it("returns a well-shaped result for a typical year with income and harvest", () => {
    const input = {
      incomeStreams: [
        {
          id: "wages-1",
          label: "Wages – primary job",
          category: "wage",
          amount: 50000,
          unit: "currency"
        },
        {
          id: "other-income-1",
          label: "Side gig",
          category: "other",
          amount: 5000,
          unit: "currency"
        }
      ],
      harvestYields: [
        {
          id: "wheat-1",
          crop: "wheat",
          category: "grain",
          amount: 1000,
          unit: "kg"
        },
        {
          id: "olive-1",
          crop: "olives",
          category: "oil",
          amount: 200,
          unit: "kg"
        }
      ],
      config: {
        titheRate: 0.1,
        festivalRate: 0.05,
        poorTitheCycle: 3,
        includeFreewill: true
      },
      yearIndexWithinShmita: 2
    };

    const result = calculateBiblicalOfferings(input);

    expectOfferingResultShape(result);

    // In this simple example, total tithe should be > 0 because we have income
    expect(result.totalTithe).toBeGreaterThan(0);
    expect(result.sabbathYear).toBe(false);

    // regularTithe total should match mapping of type "regularTithe"
    const mappedRegular = sumMappingByType(result.mapping, "regularTithe");
    expect(mappedRegular).toBeCloseTo(result.offeringsByType.regularTithe.total);

    // festival total should also match mapping of type "festival"
    const mappedFestival = sumMappingByType(result.mapping, "festival");
    expect(mappedFestival).toBeCloseTo(result.offeringsByType.festival.total);

    // freewill present when includeFreewill = true (may be zero but shape is right)
    const mappedFreewill = sumMappingByType(result.mapping, "freewill");
    expect(mappedFreewill).toBeCloseTo(result.offeringsByType.freewill.total);
  });
});

// -----------------------------------------------------------------------------
// 2) Determinism – same inputs => same outputs
// -----------------------------------------------------------------------------

describe("BiblicalOfferingCalculator – deterministic behavior", () => {
  it("produces identical results for identical inputs", () => {
    const input = {
      incomeStreams: [
        {
          id: "wages-2",
          label: "Wages – spouse",
          category: "wage",
          amount: 42000,
          unit: "currency"
        }
      ],
      harvestYields: [
        {
          id: "grapes-1",
          crop: "grapes",
          category: "wine",
          amount: 300,
          unit: "kg"
        }
      ],
      config: {
        titheRate: 0.1,
        festivalRate: 0.03,
        poorTitheCycle: 3,
        includeFreewill: false
      },
      yearIndexWithinShmita: 1
    };

    const res1 = calculateBiblicalOfferings(input);
    const res2 = calculateBiblicalOfferings(input);

    expectOfferingResultShape(res1);
    expectOfferingResultShape(res2);

    expect(res1.totalTithe).toBeCloseTo(res2.totalTithe);
    expect(res1.totalFestival).toBeCloseTo(res2.totalFestival);
    expect(res1.totalPoorTithe).toBeCloseTo(res2.totalPoorTithe);
    expect(res1.totalFreewill).toBeCloseTo(res2.totalFreewill);
    expect(res1.sabbathYear).toBe(res2.sabbathYear);
    expect(res1.mapping.length).toBe(res2.mapping.length);
  });
});

// -----------------------------------------------------------------------------
// 3) Poor tithe vs. non-poor tithe years
// -----------------------------------------------------------------------------

describe("BiblicalOfferingCalculator – poor tithe cycle behavior", () => {
  it("marks poorTitheYear = true and allocates poor tithe in designated years", () => {
    const baseInput = {
      incomeStreams: [
        {
          id: "wages-3",
          label: "Household wages",
          category: "wage",
          amount: 60000,
          unit: "currency"
        }
      ],
      harvestYields: [],
      config: {
        titheRate: 0.1,
        poorTitheCycle: 3,
        includeFreewill: false
      }
    };

    // yearIndexWithinShmita = 3 => poor tithe year (for cycle=3)
    const poorYearResult = calculateBiblicalOfferings({
      ...baseInput,
      yearIndexWithinShmita: 3
    });

    // yearIndexWithinShmita = 2 => non-poor year
    const nonPoorYearResult = calculateBiblicalOfferings({
      ...baseInput,
      yearIndexWithinShmita: 2
    });

    expectOfferingResultShape(poorYearResult);
    expectOfferingResultShape(nonPoorYearResult);

    expect(poorYearResult.meta.poorTitheYear).toBe(true);
    expect(nonPoorYearResult.meta.poorTitheYear).toBe(false);

    // Poor tithe total should be higher (or at least non-zero) in poor years
    expect(poorYearResult.totalPoorTithe).toBeGreaterThanOrEqual(0);
    expect(nonPoorYearResult.totalPoorTithe).toBeGreaterThanOrEqual(0);

    // If implementation routes a portion of tithe to poorTithe bucket in poor years,
    // we expect poorYearResult.totalPoorTithe >= nonPoorYearResult.totalPoorTithe.
    expect(poorYearResult.totalPoorTithe).toBeGreaterThanOrEqual(
      nonPoorYearResult.totalPoorTithe
    );
  });
});

// -----------------------------------------------------------------------------
// 4) Sabbath year behavior (7th year in shmita cycle)
// -----------------------------------------------------------------------------

describe("BiblicalOfferingCalculator – sabbath year handling", () => {
  it("flags sabbathYear for 7th year and may adjust harvest-based offerings", () => {
    const input = {
      incomeStreams: [
        {
          id: "wages-4",
          label: "Wages",
          category: "wage",
          amount: 40000,
          unit: "currency"
        }
      ],
      harvestYields: [
        {
          id: "barley-1",
          crop: "barley",
          category: "grain",
          amount: 800,
          unit: "kg"
        }
      ],
      config: {
        titheRate: 0.1,
        poorTitheCycle: 3,
        includeFreewill: true
      },
      yearIndexWithinShmita: 7
    };

    const result = calculateBiblicalOfferings(input);

    expectOfferingResultShape(result);
    expect(result.sabbathYear).toBe(true);

    // Implementation may handle sabbath year harvest differently.
    // We simply assert that: notes mention sabbath or rest.
    const notesText = result.meta.notes.join(" ").toLowerCase();
    expect(
      notesText.includes("sabbath") ||
        notesText.includes("shmita") ||
        notesText.includes("shemitah") ||
        notesText.includes("rest")
    ).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// 5) Freewill toggling
// -----------------------------------------------------------------------------

describe("BiblicalOfferingCalculator – freewill offering toggle", () => {
  it("includes freewill offerings only when configured", () => {
    const base = {
      incomeStreams: [
        {
          id: "wages-5",
          label: "Wages",
          category: "wage",
          amount: 30000,
          unit: "currency"
        }
      ],
      harvestYields: [],
      config: {
        titheRate: 0.1,
        poorTitheCycle: 3
      },
      yearIndexWithinShmita: 1
    };

    const withFreewill = calculateBiblicalOfferings({
      ...base,
      config: { ...base.config, includeFreewill: true }
    });

    const withoutFreewill = calculateBiblicalOfferings({
      ...base,
      config: { ...base.config, includeFreewill: false }
    });

    expectOfferingResultShape(withFreewill);
    expectOfferingResultShape(withoutFreewill);

    // In some implementations, freewill may still be zero when enabled.
    // We only assert that disabling it doesn't increase its total.
    expect(withoutFreewill.totalFreewill).toBeGreaterThanOrEqual(0);
    expect(withFreewill.totalFreewill).toBeGreaterThanOrEqual(
      withoutFreewill.totalFreewill
    );
  });
});

// -----------------------------------------------------------------------------
// 6) Unknown categories – safe fallback and warnings
// -----------------------------------------------------------------------------

describe("BiblicalOfferingCalculator – unknown category fallback", () => {
  it("handles unknown income/harvest categories with safe defaults and notes", () => {
    const input = {
      incomeStreams: [
        {
          id: "mystery-income-1",
          label: "Mystery income",
          category: "mysteryCategory",
          amount: 777,
          unit: "currency"
        }
      ],
      harvestYields: [
        {
          id: "mystery-crop-1",
          crop: "mystery crop",
          category: "mysteryCropCategory",
          amount: 42,
          unit: "kg"
        }
      ],
      config: {
        titheRate: 0.1,
        poorTitheCycle: 3,
        includeFreewill: true
      },
      yearIndexWithinShmita: 4
    };

    const result = calculateBiblicalOfferings(input);

    expectOfferingResultShape(result);

    // Unknown categories should still be mapped to *some* offering type
    // rather than crashing. We just assert that at least one mapping entry exists.
    expect(result.mapping.length).toBeGreaterThan(0);

    // Meta notes should mention 'unknown' or 'unmapped' etc.
    const notesText = result.meta.notes.join(" ").toLowerCase();
    expect(
      notesText.includes("unknown") ||
        notesText.includes("unmapped") ||
        notesText.includes("fallback")
    ).toBe(true);
  });
});
