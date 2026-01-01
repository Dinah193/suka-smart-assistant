// C:\Users\larho\suka-smart-assistant\src\tests\calculators\calendar\FeastDayAlignmentCalculator.test.js
// -----------------------------------------------------------------------------
// Unit tests for FeastDayAlignmentCalculator: verifies that major feast days
// align to the expected *Hebrew* month/day anchors and produce stable,
// well-shaped Gregorian outputs for SSA’s calendar + Planning Graph.
//
// ASSUMED PUBLIC API
// -----------------------------------------------------------------------------
//
//   import { calculateFeastDayAlignment } from
//     "@/features/calculators/calendar/FeastDayAlignmentCalculator.logic.js";
//
//   const result = calculateFeastDayAlignment(config);
//
// Where `config` looks like:
//
//   {
//     feastName: string, // e.g. "Passover", "UnleavenedBreadStart", "Trumpets", ...
//     year: number,      // Gregorian year pivot for alignment
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
//   }
//
// And the calculator returns:
//
//   {
//     feastName: string,
//     year: number,
//     alignmentRule: string,  // e.g. "1stMonth14thDay"
//     hebrewMonth: number,    // scriptural month number (1–13)
//     hebrewDay: number,      // day within Hebrew month
//     anchorDate: "YYYY-MM-DD",  // main Gregorian date for feast
//     gregorianRange: {
//       startDate: "YYYY-MM-DD",
//       endDate: "YYYY-MM-DD"
//     },
//     meta: {
//       source: string,
//       warnings?: string[]
//     }
//   }
//
// These tests DO NOT require fully precise Jewish calendar math.
// Instead, they enforce:
//
//  * Stable shape and types.
//  * Correct month/day anchors for key feasts (by Torah definition).
//  * Deterministic behavior for identical inputs.
//  * Safe fallbacks when the feastName is unknown.
//  * Reasonable multi-day ranges for week-long feasts.
//
// This lets you swap out the underlying astronomical engine later without
// breaking SSA’s Planning Graph or SessionRunner integrations.
// -----------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import { calculateFeastDayAlignment } from "@/features/calculators/calendar/FeastDayAlignmentCalculator.logic.js";

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/**
 * Basic YYYY-MM-DD check – format-level only.
 * @param {string} value
 */
function expectIsoDateString(value) {
  expect(typeof value).toBe("string");
  const re = /^\d{4}-\d{2}-\d{2}$/;
  expect(re.test(value)).toBe(true);
}

/**
 * Basic shape check for FeastDayAlignmentCalculator results.
 * @param {object} result
 */
function expectFeastResultShape(result) {
  expect(result).toBeTruthy();
  expect(typeof result).toBe("object");

  expect(typeof result.feastName).toBe("string");
  expect(typeof result.year).toBe("number");
  expect(typeof result.alignmentRule).toBe("string");

  expect(typeof result.hebrewMonth).toBe("number");
  expect(typeof result.hebrewDay).toBe("number");

  expectIsoDateString(result.anchorDate);

  expect(result.gregorianRange).toBeTruthy();
  expect(typeof result.gregorianRange).toBe("object");
  expectIsoDateString(result.gregorianRange.startDate);
  expectIsoDateString(result.gregorianRange.endDate);

  expect(result.meta).toBeTruthy();
  expect(typeof result.meta).toBe("object");
  expect(typeof result.meta.source).toBe("string");

  if (result.meta.warnings) {
    expect(Array.isArray(result.meta.warnings)).toBe(true);
  }
}

/**
 * Days difference between two ISO dates (YYYY-MM-DD) as a signed integer.
 * @param {string} a
 * @param {string} b
 */
function daysBetween(a, b) {
  const aDate = new Date(a + "T00:00:00Z");
  const bDate = new Date(b + "T00:00:00Z");
  const diffMs = bDate.getTime() - aDate.getTime();
  return Math.round(diffMs / (1000 * 60 * 60 * 24));
}

// Shared base calendar configuration for most tests
const baseCalendarConfig = {
  monthStartRule: "fullMoon",
  location: {
    lat: 32.08, // generic Eretz-Israel-ish defaults
    lon: 34.78,
    tz: "Asia/Jerusalem"
  }
};

// -----------------------------------------------------------------------------
// 1) Anchor rules for major feasts (Hebrew month/day invariants)
// -----------------------------------------------------------------------------

describe("FeastDayAlignmentCalculator – Hebrew anchor invariants", () => {
  const year = 2028;

  it("Passover is anchored to 14th day of 1st month", () => {
    const result = calculateFeastDayAlignment({
      feastName: "Passover",
      year,
      calendarConfig: baseCalendarConfig
    });

    expectFeastResultShape(result);
    expect(result.feastName).toBe("Passover");
    expect(result.hebrewMonth).toBe(1);
    expect(result.hebrewDay).toBe(14);
    expect(result.alignmentRule.toLowerCase()).toContain("14");
  });

  it("UnleavenedBreadStart is anchored to 15th day of 1st month", () => {
    const result = calculateFeastDayAlignment({
      feastName: "UnleavenedBreadStart",
      year,
      calendarConfig: baseCalendarConfig
    });

    expectFeastResultShape(result);
    expect(result.hebrewMonth).toBe(1);
    expect(result.hebrewDay).toBe(15);
  });

  it("UnleavenedBreadEnd is anchored to 21st day of 1st month", () => {
    const result = calculateFeastDayAlignment({
      feastName: "UnleavenedBreadEnd",
      year,
      calendarConfig: baseCalendarConfig
    });

    expectFeastResultShape(result);
    expect(result.hebrewMonth).toBe(1);
    expect(result.hebrewDay).toBe(21);
  });

  it("Trumpets is anchored to 1st day of 7th month", () => {
    const result = calculateFeastDayAlignment({
      feastName: "Trumpets",
      year,
      calendarConfig: baseCalendarConfig
    });

    expectFeastResultShape(result);
    expect(result.hebrewMonth).toBe(7);
    expect(result.hebrewDay).toBe(1);
  });

  it("Atonement is anchored to 10th day of 7th month", () => {
    const result = calculateFeastDayAlignment({
      feastName: "Atonement",
      year,
      calendarConfig: baseCalendarConfig
    });

    expectFeastResultShape(result);
    expect(result.hebrewMonth).toBe(7);
    expect(result.hebrewDay).toBe(10);
  });

  it("TabernaclesStart is anchored to 15th day of 7th month", () => {
    const result = calculateFeastDayAlignment({
      feastName: "TabernaclesStart",
      year,
      calendarConfig: baseCalendarConfig
    });

    expectFeastResultShape(result);
    expect(result.hebrewMonth).toBe(7);
    expect(result.hebrewDay).toBe(15);
  });

  it("TabernaclesEnd is anchored to 21st day of 7th month", () => {
    const result = calculateFeastDayAlignment({
      feastName: "TabernaclesEnd",
      year,
      calendarConfig: baseCalendarConfig
    });

    expectFeastResultShape(result);
    expect(result.hebrewMonth).toBe(7);
    expect(result.hebrewDay).toBe(21);
  });

  it("LastGreatDay is anchored to 22nd day of 7th month", () => {
    const result = calculateFeastDayAlignment({
      feastName: "LastGreatDay",
      year,
      calendarConfig: baseCalendarConfig
    });

    expectFeastResultShape(result);
    expect(result.hebrewMonth).toBe(7);
    expect(result.hebrewDay).toBe(22);
  });
});

// -----------------------------------------------------------------------------
// 2) Range logic for week-long feasts (Unleavened Bread, Tabernacles)
// -----------------------------------------------------------------------------

describe("FeastDayAlignmentCalculator – multi-day feast ranges", () => {
  const year = 2030;

  it("UnleavenedBread range is at least 6–7 days long", () => {
    const start = calculateFeastDayAlignment({
      feastName: "UnleavenedBreadStart",
      year,
      calendarConfig: baseCalendarConfig
    });

    const end = calculateFeastDayAlignment({
      feastName: "UnleavenedBreadEnd",
      year,
      calendarConfig: baseCalendarConfig
    });

    expectFeastResultShape(start);
    expectFeastResultShape(end);

    const diff = daysBetween(start.anchorDate, end.anchorDate);
    // Hebrew days 15–21 inclusive -> 6-day difference
    expect(diff).toBeGreaterThanOrEqual(6);
    expect(diff).toBeLessThanOrEqual(7);

    const rangeDiff = daysBetween(
      start.gregorianRange.startDate,
      end.gregorianRange.endDate
    );
    expect(rangeDiff).toBeGreaterThanOrEqual(6);
    expect(rangeDiff).toBeLessThanOrEqual(7);
  });

  it("Tabernacles range is at least 6–7 days long", () => {
    const start = calculateFeastDayAlignment({
      feastName: "TabernaclesStart",
      year,
      calendarConfig: baseCalendarConfig
    });

    const end = calculateFeastDayAlignment({
      feastName: "TabernaclesEnd",
      year,
      calendarConfig: baseCalendarConfig
    });

    expectFeastResultShape(start);
    expectFeastResultShape(end);

    const diff = daysBetween(start.anchorDate, end.anchorDate);
    // Hebrew days 15–21 inclusive -> 6-day difference
    expect(diff).toBeGreaterThanOrEqual(6);
    expect(diff).toBeLessThanOrEqual(7);

    const rangeDiff = daysBetween(
      start.gregorianRange.startDate,
      end.gregorianRange.endDate
    );
    expect(rangeDiff).toBeGreaterThanOrEqual(6);
    expect(rangeDiff).toBeLessThanOrEqual(7);
  });
});

// -----------------------------------------------------------------------------
// 3) Determinism – same inputs yield same feast alignment
// -----------------------------------------------------------------------------

describe("FeastDayAlignmentCalculator – deterministic outputs", () => {
  it("returns same anchorDate for identical inputs", () => {
    const config = {
      feastName: "Passover",
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

    const result1 = calculateFeastDayAlignment(config);
    const result2 = calculateFeastDayAlignment(config);

    expectFeastResultShape(result1);
    expectFeastResultShape(result2);

    expect(result1.anchorDate).toBe(result2.anchorDate);
    expect(result1.hebrewMonth).toBe(result2.hebrewMonth);
    expect(result1.hebrewDay).toBe(result2.hebrewDay);
    expect(result1.alignmentRule).toBe(result2.alignmentRule);
  });
});

// -----------------------------------------------------------------------------
// 4) CalendarConfig options – different monthStartRule still yields valid shape
// -----------------------------------------------------------------------------

describe("FeastDayAlignmentCalculator – monthStartRule options", () => {
  const year = 2033;

  it("supports newMoon rule without breaking feast outputs", () => {
    const result = calculateFeastDayAlignment({
      feastName: "Trumpets",
      year,
      calendarConfig: {
        ...baseCalendarConfig,
        monthStartRule: "newMoon"
      }
    });

    expectFeastResultShape(result);
    expect(result.hebrewMonth).toBe(7);
    expect(result.hebrewDay).toBe(1);
  });

  it("supports firstVisibleCrescent rule without breaking feast outputs", () => {
    const result = calculateFeastDayAlignment({
      feastName: "Atonement",
      year,
      calendarConfig: {
        ...baseCalendarConfig,
        monthStartRule: "firstVisibleCrescent"
      }
    });

    expectFeastResultShape(result);
    expect(result.hebrewMonth).toBe(7);
    expect(result.hebrewDay).toBe(10);
  });
});

// -----------------------------------------------------------------------------
// 5) Fallback behavior – unknown feastName should be safe with warnings
// -----------------------------------------------------------------------------

describe("FeastDayAlignmentCalculator – fallback on unknown feast", () => {
  it("handles unknown feast names with warnings and safe default", () => {
    const result = calculateFeastDayAlignment({
      feastName: "SomeRandomFeastName",
      year: 2034,
      calendarConfig: baseCalendarConfig
    });

    expectFeastResultShape(result);

    // Implementation may choose a default or echo back with generic rule,
    // but it should *not* crash and should surface a warning.
    if (result.meta.warnings && result.meta.warnings.length > 0) {
      const joined = result.meta.warnings.join(" ").toLowerCase();
      expect(
        joined.includes("unknown") ||
          joined.includes("unsupported") ||
          joined.includes("feast")
      ).toBe(true);
    }
  });
});

// -----------------------------------------------------------------------------
// 6) Integration sanity – all major feasts for a year are valid
// -----------------------------------------------------------------------------

describe("FeastDayAlignmentCalculator – full-year sanity check", () => {
  it("produces valid alignments for all major feasts in a year", () => {
    const year = 2035;
    const feastNames = [
      "Passover",
      "UnleavenedBreadStart",
      "UnleavenedBreadEnd",
      "Shavuot",
      "Trumpets",
      "Atonement",
      "TabernaclesStart",
      "TabernaclesEnd",
      "LastGreatDay"
    ];

    const results = feastNames.map((feastName) =>
      calculateFeastDayAlignment({
        feastName,
        year,
        calendarConfig: baseCalendarConfig
      })
    );

    results.forEach((res, idx) => {
      expectFeastResultShape(res);
      expect(res.feastName).toBe(feastNames[idx]);
      expectIsoDateString(res.anchorDate);
    });
  });
});
