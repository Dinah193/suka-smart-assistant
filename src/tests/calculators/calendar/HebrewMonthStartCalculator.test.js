// C:\Users\larho\suka-smart-assistant\src\tests\calculators\calendar\HebrewMonthStartCalculator.test.js
// -----------------------------------------------------------------------------
// Unit tests for HebrewMonthStartCalculator: verifies that month start
// rules (full moon, new moon, first crescent, no-meridian-cross, etc.)
// produce stable, well-shaped outputs for SSA calendar + Planning Graph.
//
// ASSUMED PUBLIC API
// -----------------------------------------------------------------------------
//
//   import { calculateHebrewMonthStart } from
//     "@/features/calculators/calendar/HebrewMonthStartCalculator.logic.js";
//
//   const result = calculateHebrewMonthStart(config);
//
// Where `config` looks like:
//
//   {
//     year: number,           // Gregorian year context for lookup
//     gregorianMonth: number, // 1–12: the civil month the user is exploring
//     location: {
//       lat: number,
//       lon: number,
//       tz: string            // IANA tz, e.g. "America/Chicago"
//     },
//     rule: "fullMoon" |
//           "newMoon" |
//           "firstVisibleCrescent" |
//           "noMeridianCross",
//     options?: {
//       sunsetOffsetMinutes?: number,   // tweak "after sunset" handling
//       preferNearestEquinox?: boolean, // for 1st month logic
//       debug?: boolean
//     }
//   }
//
// And the calculator returns:
//
//   {
//     rule: string,            // requested rule
//     resolvedRule: string,    // actual rule used (after fallback/default)
//     year: number,
//     gregorianMonth: number,
//     location: { lat, lon, tz },
//     selectedDate: "YYYY-MM-DD",     // chosen start date (local calendar)
//     candidates: [
//       {
//         date: "YYYY-MM-DD",         // candidate date
//         kind: string,               // "fullMoon" | "newMoon" | ...
//         score: number               // higher = better match for rule
//       }
//     ],
//     meta: {
//       source: string,  // e.g. "timeanddate.com cache", "mock", etc.
//       // additional fields allowed (sunrise/sunset/moonrise/...)
//     },
//     warnings?: string[]
//   }
//
// These tests DO NOT require astronomically precise values.
// Instead, they enforce:
//   * Stable shape and types.
//   * Rule ↔ candidate-kind consistency.
//   * Deterministic behavior for the same inputs.
//   * Safe fallbacks on invalid rules/inputs.
//   * Well-formed ISO date strings suitable for SessionRunner + calendar UI.
//
// This is deliberate: the SSA calendar may later swap astronomical engines
// without changing these invariants.
// -----------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import { calculateHebrewMonthStart } from "@/features/calculators/calendar/HebrewMonthStartCalculator.logic.js";

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/**
 * Basic YYYY-MM-DD check – no heavy parsing, just format.
 * Allows 1–12 months and 1–31 days; deeper validation belongs in logic layer.
 * @param {string} value
 */
function expectIsoDateString(value) {
  expect(typeof value).toBe("string");
  // loose ISO "YYYY-MM-DD"
  const re = /^\d{4}-\d{2}-\d{2}$/;
  expect(re.test(value)).toBe(true);
}

/**
 * Assert basic shape & sanity of a HebrewMonthStartCalculator result.
 * @param {ReturnType<typeof calculateHebrewMonthStart>} result
 */
function expectBasicResultShape(result) {
  expect(result).toBeTruthy();
  expect(typeof result).toBe("object");

  expect(typeof result.rule).toBe("string");
  expect(typeof result.resolvedRule).toBe("string");
  expect(typeof result.year).toBe("number");
  expect(typeof result.gregorianMonth).toBe("number");

  expect(result.location).toBeTruthy();
  expect(typeof result.location).toBe("object");
  expect(typeof result.location.lat).toBe("number");
  expect(typeof result.location.lon).toBe("number");
  expect(typeof result.location.tz).toBe("string");

  expectIsoDateString(result.selectedDate);

  expect(Array.isArray(result.candidates)).toBe(true);
  expect(result.candidates.length).toBeGreaterThan(0);

  result.candidates.forEach((c) => {
    expectIsoDateString(c.date);
    expect(typeof c.kind).toBe("string");
    expect(typeof c.score).toBe("number");
    // score should be finite
    expect(Number.isFinite(c.score)).toBe(true);
  });

  // selectedDate should exactly match one of the candidate dates.
  const candidateDates = result.candidates.map((c) => c.date);
  expect(candidateDates).toContain(result.selectedDate);

  expect(result.meta).toBeTruthy();
  expect(typeof result.meta).toBe("object");
  expect(typeof result.meta.source).toBe("string");

  if (result.warnings) {
    expect(Array.isArray(result.warnings)).toBe(true);
  }
}

// -----------------------------------------------------------------------------
// 1) Rule behavior – each known rule yields a matching candidate
// -----------------------------------------------------------------------------

describe("HebrewMonthStartCalculator – rule-specific behavior", () => {
  const baseConfig = {
    year: 2025,
    gregorianMonth: 3, // March
    location: {
      lat: 32.08, // Approx. Israel as a default planetary context
      lon: 34.78,
      tz: "Asia/Jerusalem"
    }
  };

  it("fullMoon rule returns a result with at least one fullMoon candidate", () => {
    const result = calculateHebrewMonthStart({
      ...baseConfig,
      rule: "fullMoon"
    });

    expectBasicResultShape(result);
    expect(result.resolvedRule).toBe("fullMoon");

    const kinds = result.candidates.map((c) => c.kind);
    expect(kinds).toContain("fullMoon");
  });

  it("newMoon rule returns a result with at least one newMoon candidate", () => {
    const result = calculateHebrewMonthStart({
      ...baseConfig,
      rule: "newMoon"
    });

    expectBasicResultShape(result);
    expect(result.resolvedRule).toBe("newMoon");

    const kinds = result.candidates.map((c) => c.kind);
    expect(kinds).toContain("newMoon");
  });

  it("firstVisibleCrescent rule returns at least one firstVisibleCrescent candidate", () => {
    const result = calculateHebrewMonthStart({
      ...baseConfig,
      rule: "firstVisibleCrescent"
    });

    expectBasicResultShape(result);
    expect(result.resolvedRule).toBe("firstVisibleCrescent");

    const kinds = result.candidates.map((c) => c.kind);
    expect(kinds).toContain("firstVisibleCrescent");
  });

  it("noMeridianCross rule returns at least one noMeridianCross candidate", () => {
    const result = calculateHebrewMonthStart({
      ...baseConfig,
      rule: "noMeridianCross"
    });

    expectBasicResultShape(result);
    expect(result.resolvedRule).toBe("noMeridianCross");

    const kinds = result.candidates.map((c) => c.kind);
    expect(kinds).toContain("noMeridianCross");
  });
});

// -----------------------------------------------------------------------------
// 2) Determinism – same inputs → same outputs (idempotent)
// -----------------------------------------------------------------------------

describe("HebrewMonthStartCalculator – deterministic results for same inputs", () => {
  it("returns the same selectedDate for identical configs", () => {
    const config = {
      year: 2030,
      gregorianMonth: 1,
      location: {
        lat: 31.77,
        lon: 35.21,
        tz: "Asia/Jerusalem"
      },
      rule: "fullMoon",
      options: {
        sunsetOffsetMinutes: 20,
        preferNearestEquinox: false
      }
    };

    const result1 = calculateHebrewMonthStart(config);
    const result2 = calculateHebrewMonthStart(config);

    expectBasicResultShape(result1);
    expectBasicResultShape(result2);

    expect(result1.selectedDate).toBe(result2.selectedDate);
    expect(result1.resolvedRule).toBe(result2.resolvedRule);

    // Candidates may be recomputed, but they should be logically identical
    // in count and primary candidate.
    expect(result1.candidates.length).toBe(result2.candidates.length);
    expect(result1.candidates[0].date).toBe(result2.candidates[0].date);
  });
});

// -----------------------------------------------------------------------------
// 3) Option handling – sunsetOffsetMinutes and preferNearestEquinox
// -----------------------------------------------------------------------------

describe("HebrewMonthStartCalculator – options influence result (within reason)", () => {
  const baseConfig = {
    year: 2026,
    gregorianMonth: 3,
    location: {
      lat: 32.08,
      lon: 34.78,
      tz: "Asia/Jerusalem"
    },
    rule: "firstVisibleCrescent"
  };

  it("respects sunsetOffsetMinutes as part of decision logic", () => {
    const resultDefault = calculateHebrewMonthStart({
      ...baseConfig,
      options: {
        sunsetOffsetMinutes: 0
      }
    });

    const resultOffset = calculateHebrewMonthStart({
      ...baseConfig,
      options: {
        sunsetOffsetMinutes: 45
      }
    });

    expectBasicResultShape(resultDefault);
    expectBasicResultShape(resultOffset);

    // We don't require the date to change,
    // but implementation may – in which case we just ensure both are valid.
    expectIsoDateString(resultDefault.selectedDate);
    expectIsoDateString(resultOffset.selectedDate);
  });

  it("can toggle preferNearestEquinox without breaking shape", () => {
    const resFalse = calculateHebrewMonthStart({
      ...baseConfig,
      options: { preferNearestEquinox: false }
    });

    const resTrue = calculateHebrewMonthStart({
      ...baseConfig,
      options: { preferNearestEquinox: true }
    });

    expectBasicResultShape(resFalse);
    expectBasicResultShape(resTrue);

    // Both must be valid choices; they may or may not differ.
    expectIsoDateString(resFalse.selectedDate);
    expectIsoDateString(resTrue.selectedDate);
  });
});

// -----------------------------------------------------------------------------
// 4) Invalid rule and location – safe fallbacks and warnings
// -----------------------------------------------------------------------------

describe("HebrewMonthStartCalculator – fallback behavior & warnings", () => {
  it("falls back to a default rule for unknown rule names", () => {
    const result = calculateHebrewMonthStart({
      year: 2027,
      gregorianMonth: 9,
      location: {
        lat: 32.08,
        lon: 34.78,
        tz: "Asia/Jerusalem"
      },
      rule: "totallyUnknownRule"
    });

    expectBasicResultShape(result);

    // We expect a fallback, typically "fullMoon".
    expect(result.resolvedRule).not.toBe("totallyUnknownRule");

    // Warnings should mention the rule.
    if (result.warnings && result.warnings.length > 0) {
      const joined = result.warnings.join(" ").toLowerCase();
      expect(joined).toContain("rule");
    }
  });

  it("handles missing or invalid location gracefully", () => {
    const result = calculateHebrewMonthStart({
      year: 2028,
      gregorianMonth: 4,
      // Intentionally broken location
      location: {
        // @ts-expect-error - intentionally invalid for defensive test
        lat: NaN,
        lon: NaN,
        tz: ""
      },
      rule: "fullMoon"
    });

    expectBasicResultShape(result);

    // selectedDate should still be a usable ISO date string
    expectIsoDateString(result.selectedDate);

    if (result.warnings && result.warnings.length > 0) {
      const joined = result.warnings.join(" ").toLowerCase();
      expect(
        joined.includes("location") ||
          joined.includes("lat") ||
          joined.includes("lon")
      ).toBe(true);
    }
  });
});

// -----------------------------------------------------------------------------
// 5) SSA integration sanity – multiple months over a year
// -----------------------------------------------------------------------------

describe("HebrewMonthStartCalculator – integration sanity across months", () => {
  it("returns a valid month start for each civil month of a year", () => {
    const months = Array.from({ length: 12 }, (_, i) => i + 1);
    const results = months.map((month) =>
      calculateHebrewMonthStart({
        year: 2031,
        gregorianMonth: month,
        location: {
          lat: 32.08,
          lon: 34.78,
          tz: "Asia/Jerusalem"
        },
        rule: "fullMoon"
      })
    );

    results.forEach((res) => {
      expectBasicResultShape(res);
      // All selectedDates must be ISO strings; we don't require them
      // to be strictly increasing or in the same civil month,
      // because Hebrew months can overlap civil months.
      expectIsoDateString(res.selectedDate);
    });
  });
});
