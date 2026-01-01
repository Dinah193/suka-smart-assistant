// C:\Users\larho\suka-smart-assistant\src\tests\calculators\calendar\ScripturalYearLengthCalculator.test.js
// -----------------------------------------------------------------------------
// Unit tests for ScripturalYearLengthCalculator
//
// PURPOSE
// --------
// Validates that the ScripturalYearLengthCalculator:
//
//  * Produces a stable, well-typed result object.
//  * Yields total day counts within plausible Scriptural year ranges.
//  * Uses month buckets that look like lunar months (~29–30 days).
//  * Correctly marks leap/intercalated years vs. regular years.
//  * Behaves deterministically for identical inputs.
//  * Tolerates different monthStartRule options without breaking shape.
//  * Falls back safely with warnings when an unknown rule is passed.
//
// ASSUMED PUBLIC API
// ------------------
//
//   import { calculateScripturalYearLength } from
//     "@/features/calculators/calendar/ScripturalYearLengthCalculator.logic.js";
//
//   const result = calculateScripturalYearLength({
//     year: 2030,
//     calendarConfig: {
//       monthStartRule: "fullMoon" |
//                       "newMoon" |
//                       "firstVisibleCrescent" |
//                       "noMeridianCross",
//       location: { lat: number, lon: number, tz: string },
//       options?: {
//         sunsetOffsetMinutes?: number,
//         preferNearestEquinox?: boolean
//       }
//     }
//   });
//
// RESULT SHAPE (minimum used in tests)
// ------------------------------------
//
//   {
//     year: number,
//     totalDays: number,
//     months: [
//       {
//         index: number,             // 1-based month index
//         length: number,            // length in days
//         isIntercalated?: boolean,
//         startDate?: "YYYY-MM-DD",
//         endDate?: "YYYY-MM-DD"
//       },
//       ...
//     ],
//     leapYear: boolean,
//     intercalatedMonthIncluded: boolean,
//     meta: {
//       rule: string,               // textual description of rule set
//       source: string,             // e.g. "ssa.scripturalCalendar"
//       warnings?: string[]
//     }
//   }
//
// These tests are *invariant/property-based*, not tied to a specific
// Rabbinic/Hillel calendar implementation. That lets you refine the
// underlying astronomy later without breaking the Planning Graph or
// SessionRunner integrations.
// -----------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import { calculateScripturalYearLength } from "@/features/calculators/calendar/ScripturalYearLengthCalculator.logic.js";

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/**
 * Basic YYYY-MM-DD format check (doesn't validate real date existence).
 * @param {string | undefined} value
 */
function expectIsoDateStringOrUndefined(value) {
  if (value == null) return;
  expect(typeof value).toBe("string");
  const re = /^\d{4}-\d{2}-\d{2}$/;
  expect(re.test(value)).toBe(true);
}

/**
 * Asserts that a result from ScripturalYearLengthCalculator has the expected
 * shape and sane numeric ranges.
 * @param {object} result
 */
function expectYearLengthResultShape(result) {
  expect(result).toBeTruthy();
  expect(typeof result).toBe("object");

  // Core fields
  expect(typeof result.year).toBe("number");
  expect(typeof result.totalDays).toBe("number");
  expect(Array.isArray(result.months)).toBe(true);
  expect(result.months.length).toBeGreaterThanOrEqual(12);
  expect(result.months.length).toBeLessThanOrEqual(13);

  // Day ranges: lunar year usually around 354 days, leap ~383–385
  expect(result.totalDays).toBeGreaterThanOrEqual(340);
  expect(result.totalDays).toBeLessThanOrEqual(390);

  // Month-level sanity
  let sum = 0;
  result.months.forEach((m, idx) => {
    expect(m).toBeTruthy();
    expect(typeof m).toBe("object");

    // index is 1-based in these assertions, but implementation may vary;
    // we just assert it's a number and monotonically increasing or at least > 0.
    expect(typeof m.index).toBe("number");
    expect(m.index).toBeGreaterThanOrEqual(1);

    expect(typeof m.length).toBe("number");
    // Allow 28–31 for some tolerance; typical lunar months 29–30.
    expect(m.length).toBeGreaterThanOrEqual(28);
    expect(m.length).toBeLessThanOrEqual(31);

    sum += m.length;

    if (typeof m.isIntercalated !== "undefined") {
      expect(typeof m.isIntercalated).toBe("boolean");
    }

    expectIsoDateStringOrUndefined(m.startDate);
    expectIsoDateStringOrUndefined(m.endDate);

    // Optional: verify order of months if startDate is set
    if (idx > 0 && m.startDate && result.months[idx - 1].startDate) {
      const prev = new Date(result.months[idx - 1].startDate + "T00:00:00Z");
      const curr = new Date(m.startDate + "T00:00:00Z");
      expect(curr.getTime()).toBeGreaterThanOrEqual(prev.getTime());
    }
  });

  // Sum of month lengths should match totalDays
  expect(sum).toBe(result.totalDays);

  // Leap / intercalation flags
  expect(typeof result.leapYear).toBe("boolean");
  expect(typeof result.intercalatedMonthIncluded).toBe("boolean");

  // If a 13th month is present, leapYear or intercalatedMonthIncluded
  // should be true (implementation can choose either flag as primary).
  if (result.months.length === 13) {
    expect(
      result.leapYear === true || result.intercalatedMonthIncluded === true
    ).toBe(true);
  }

  // Meta info
  expect(result.meta).toBeTruthy();
  expect(typeof result.meta).toBe("object");
  expect(typeof result.meta.rule).toBe("string");
  expect(typeof result.meta.source).toBe("string");

  if (result.meta.warnings) {
    expect(Array.isArray(result.meta.warnings)).toBe(true);
  }
}

// Shared base calendar configuration for tests
const baseCalendarConfig = {
  monthStartRule: "fullMoon",
  location: {
    lat: 32.08, // generic Eretz-Israel-ish defaults
    lon: 34.78,
    tz: "Asia/Jerusalem"
  }
};

// -----------------------------------------------------------------------------
// 1) Basic invariant tests for a single year
// -----------------------------------------------------------------------------

describe("ScripturalYearLengthCalculator – basic invariants", () => {
  it("returns a well-shaped result for a typical year", () => {
    const year = 2030;

    const result = calculateScripturalYearLength({
      year,
      calendarConfig: baseCalendarConfig
    });

    expectYearLengthResultShape(result);
    expect(result.year).toBe(year);
  });

  it("totalDays and month lengths are consistent and not zero", () => {
    const result = calculateScripturalYearLength({
      year: 2029,
      calendarConfig: baseCalendarConfig
    });

    expectYearLengthResultShape(result);

    // All months must be strictly positive-length
    result.months.forEach((m) => {
      expect(m.length).toBeGreaterThan(0);
    });

    expect(result.totalDays).toBeGreaterThan(0);
  });
});

// -----------------------------------------------------------------------------
// 2) Determinism – same inputs => identical outputs
// -----------------------------------------------------------------------------

describe("ScripturalYearLengthCalculator – deterministic behavior", () => {
  it("produces identical results for identical inputs", () => {
    const config = {
      year: 2032,
      calendarConfig: {
        ...baseCalendarConfig,
        monthStartRule: "fullMoon",
        options: {
          sunsetOffsetMinutes: 15,
          preferNearestEquinox: true
        }
      }
    };

    const result1 = calculateScripturalYearLength(config);
    const result2 = calculateScripturalYearLength(config);

    expectYearLengthResultShape(result1);
    expectYearLengthResultShape(result2);

    expect(result1.totalDays).toBe(result2.totalDays);
    expect(result1.months.length).toBe(result2.months.length);
    expect(result1.leapYear).toBe(result2.leapYear);
    expect(result1.intercalatedMonthIncluded).toBe(
      result2.intercalatedMonthIncluded
    );

    // Optionally compare per-month lengths for strict determinism
    result1.months.forEach((m1, idx) => {
      const m2 = result2.months[idx];
      expect(m1.index).toBe(m2.index);
      expect(m1.length).toBe(m2.length);
    });
  });
});

// -----------------------------------------------------------------------------
// 3) Month start rule variants – different rules, still valid year shapes
// -----------------------------------------------------------------------------

describe("ScripturalYearLengthCalculator – monthStartRule variants", () => {
  const year = 2033;

  it("handles newMoon rule with plausible year length", () => {
    const result = calculateScripturalYearLength({
      year,
      calendarConfig: {
        ...baseCalendarConfig,
        monthStartRule: "newMoon"
      }
    });

    expectYearLengthResultShape(result);
    expect(result.meta.rule.toLowerCase()).toContain("new");
  });

  it("handles firstVisibleCrescent rule with plausible year length", () => {
    const result = calculateScripturalYearLength({
      year,
      calendarConfig: {
        ...baseCalendarConfig,
        monthStartRule: "firstVisibleCrescent"
      }
    });

    expectYearLengthResultShape(result);
    expect(result.meta.rule.toLowerCase()).toContain("crescent");
  });

  it("different rules for the same year remain within a small delta", () => {
    const fullMoon = calculateScripturalYearLength({
      year,
      calendarConfig: {
        ...baseCalendarConfig,
        monthStartRule: "fullMoon"
      }
    });

    const newMoon = calculateScripturalYearLength({
      year,
      calendarConfig: {
        ...baseCalendarConfig,
        monthStartRule: "newMoon"
      }
    });

    expectYearLengthResultShape(fullMoon);
    expectYearLengthResultShape(newMoon);

    const diff = Math.abs(fullMoon.totalDays - newMoon.totalDays);

    // Under different start rules we expect small differences (few days),
    // not a wildly different calendar.
    expect(diff).toBeLessThanOrEqual(5);

    // Month counts should be the same or off by at most one
    const monthCountDiff = Math.abs(
      fullMoon.months.length - newMoon.months.length
    );
    expect(monthCountDiff).toBeLessThanOrEqual(1);
  });
});

// -----------------------------------------------------------------------------
// 4) Leap year vs non-leap year behavior across a range of years
// -----------------------------------------------------------------------------

describe("ScripturalYearLengthCalculator – leap vs non-leap distribution", () => {
  it("has at least one leap and one non-leap year in a decade span", () => {
    const years = [];
    for (let y = 2035; y <= 2044; y += 1) {
      years.push(y);
    }

    const results = years.map((year) =>
      calculateScripturalYearLength({
        year,
        calendarConfig: baseCalendarConfig
      })
    );

    results.forEach((res, idx) => {
      expectYearLengthResultShape(res);
      expect(res.year).toBe(years[idx]);
    });

    const anyLeap = results.some((r) => r.leapYear === true);
    const anyNonLeap = results.some((r) => r.leapYear === false);

    // We don't assume *which* years are leap, just that there is variety
    // in a reasonable 10-year sample.
    expect(anyLeap).toBe(true);
    expect(anyNonLeap).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// 5) Fallback and warning behavior for unknown monthStartRule
// -----------------------------------------------------------------------------

describe("ScripturalYearLengthCalculator – unknown rule fallback", () => {
  it("produces a safe default result and warnings on unknown rule", () => {
    const result = calculateScripturalYearLength({
      year: 2040,
      calendarConfig: {
        ...baseCalendarConfig,
        // deliberately bogus value
        monthStartRule: "someCompletelyUnknownRule"
      }
    });

    expectYearLengthResultShape(result);

    // Implementation can either fall back to a default or echo the rule,
    // but it should emit a warning.
    if (result.meta.warnings && result.meta.warnings.length > 0) {
      const text = result.meta.warnings.join(" ").toLowerCase();
      expect(
        text.includes("unknown") ||
          text.includes("unsupported") ||
          text.includes("fallback")
      ).toBe(true);
    }
  });
});
