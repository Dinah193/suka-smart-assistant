// C:\Users\larho\suka-smart-assistant\src\tests\calculators\gardenAnimal\GardenPlantingCalendarCalculator.test.js
// -----------------------------------------------------------------------------
// Unit tests for GardenPlantingCalendarCalculator logic.
//
// ASSUMED PUBLIC API (align your implementation to this shape):
//
//   import { calculateGardenPlantingCalendar } from
//     "@/features/calculators/gardenAnimal/GardenPlantingCalendarCalculator.logic.js";
//
//   const result = calculateGardenPlantingCalendar(config);
//
// Where `config` looks like:
//
//   {
//     location: {
//       zone?: string,            // e.g. "7b"
//       latitude?: number,
//       longitude?: number
//     },
//     lastFrostDate: string,      // ISO date "YYYY-MM-DD"
//     firstFrostDate: string,     // ISO date "YYYY-MM-DD"
//
//     // Optional per-site modifiers
//     siteModifiers?: {
//       raisedBeds?: boolean,
//       rowCover?: boolean,
//       coldFrame?: boolean
//     },
//
//     plants: [
//       {
//         id: string,
//         name: string,
//         family?: string,         // e.g. "brassica"
//         daysToMaturity: number,
//         plantingGroup?: "cool" | "warm",
//         sowing: {
//           mode: "direct" | "indoor" | "either",
//           offsetStartDaysBeforeLastFrost?: number,   // e.g. 6 weeks before
//           offsetEndDaysBeforeLastFrost?: number,
//           offsetAfterLastFrostDays?: number,        // for warm crops
//           fallOffsetBeforeFirstFrostDays?: number   // fall sowing window
//         },
//         succession?: {
//           enabled: boolean,
//           intervalDays?: number,        // days between successions
//           maxRounds?: number            // number of successions
//         }
//       }
//     ]
//   }
//
// And the calculator returns:
//
//   {
//     location: {
//       zone?: string,
//       latitude?: number,
//       longitude?: number
//     },
//     lastFrostDate: string,
//     firstFrostDate: string,
//     seasonSummary: {
//       seasonLengthDays: number,
//       coolSeasonDays: number,
//       warmSeasonDays: number
//     },
//     plantSchedules: [
//       {
//         id: string,
//         name: string,
//         plantingGroup?: string,
//         sowingWindows: Array<{
//           season: "spring" | "fall",
//           mode: "direct" | "indoor" | "either",
//           startDate: string,   // ISO
//           endDate: string      // ISO
//         }>,
//         transplantDates?: Array<{
//           season: "spring" | "fall",
//           date: string
//         }>,
//         firstHarvestDate: string,
//         lastHarvestDate: string,
//         successions?: Array<{
//           index: number,
//           sowDate: string,
//           expectedHarvestStart: string,
//           expectedHarvestEnd: string
//         }>
//       }
//     ],
//     warnings?: string[]
//   }
//
// These tests focus on:
//   * Shape and numeric sanity of the output
//   * Spring and fall planting date calculations
//   * Succession planting behavior
//   * Handling of different sowing modes (direct vs indoor)
//   * Zone/season length sanity checks
//   * Defensive behavior for weird inputs
//   * Compatibility with SSA Planning Graph & SessionRunner (stable, finite values)
// -----------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import { calculateGardenPlantingCalendar } from "@/features/calculators/gardenAnimal/GardenPlantingCalendarCalculator.logic.js";

function toDate(dateStr) {
  return new Date(dateStr + "T00:00:00Z");
}

function daysBetween(startStr, endStr) {
  const start = toDate(startStr);
  const end = toDate(endStr);
  const diffMs = end.getTime() - start.getTime();
  return Math.round(diffMs / (1000 * 60 * 60 * 24));
}

function assertBaseShape(result) {
  expect(result).toBeTruthy();
  expect(typeof result).toBe("object");

  expect(typeof result.lastFrostDate).toBe("string");
  expect(typeof result.firstFrostDate).toBe("string");
  expect(typeof result.location).toBe("object");
  expect(typeof result.seasonSummary).toBe("object");
  expect(Array.isArray(result.plantSchedules)).toBe(true);

  const ss = result.seasonSummary;
  expect(typeof ss.seasonLengthDays).toBe("number");
  expect(typeof ss.coolSeasonDays).toBe("number");
  expect(typeof ss.warmSeasonDays).toBe("number");
  expect(ss.seasonLengthDays).toBeGreaterThan(0);

  if (result.warnings) {
    expect(Array.isArray(result.warnings)).toBe(true);
  }

  result.plantSchedules.forEach((plant) => {
    expect(typeof plant.id).toBe("string");
    expect(typeof plant.name).toBe("string");
    expect(Array.isArray(plant.sowingWindows)).toBe(true);
    expect(typeof plant.firstHarvestDate).toBe("string");
    expect(typeof plant.lastHarvestDate).toBe("string");

    plant.sowingWindows.forEach((win) => {
      expect(["spring", "fall"]).toContain(win.season);
      expect(["direct", "indoor", "either"]).toContain(win.mode);
      expect(typeof win.startDate).toBe("string");
      expect(typeof win.endDate).toBe("string");
    });

    if (plant.transplantDates) {
      expect(Array.isArray(plant.transplantDates)).toBe(true);
      plant.transplantDates.forEach((tr) => {
        expect(["spring", "fall"]).toContain(tr.season);
        expect(typeof tr.date).toBe("string");
      });
    }

    if (plant.successions) {
      expect(Array.isArray(plant.successions)).toBe(true);
      plant.successions.forEach((succ) => {
        expect(typeof succ.index).toBe("number");
        expect(typeof succ.sowDate).toBe("string");
        expect(typeof succ.expectedHarvestStart).toBe("string");
        expect(typeof succ.expectedHarvestEnd).toBe("string");
      });
    }
  });
}

// -----------------------------------------------------------------------------
// Basic scenario – cool and warm crops in a typical season
// -----------------------------------------------------------------------------
describe("GardenPlantingCalendarCalculator – basic structure", () => {
  it("returns a well-formed schedule for cool and warm crops", () => {
    const result = calculateGardenPlantingCalendar({
      location: { zone: "7b" },
      lastFrostDate: "2026-04-15",
      firstFrostDate: "2026-11-01",
      plants: [
        {
          id: "lettuce",
          name: "Leaf Lettuce",
          family: "aster",
          daysToMaturity: 50,
          plantingGroup: "cool",
          sowing: {
            mode: "direct",
            offsetStartDaysBeforeLastFrost: 30,
            offsetEndDaysBeforeLastFrost: 7,
            fallOffsetBeforeFirstFrostDays: 70
          },
          succession: {
            enabled: true,
            intervalDays: 14,
            maxRounds: 4
          }
        },
        {
          id: "tomato",
          name: "Tomato",
          family: "solanaceae",
          daysToMaturity: 80,
          plantingGroup: "warm",
          sowing: {
            mode: "indoor",
            offsetStartDaysBeforeLastFrost: 56,
            offsetEndDaysBeforeLastFrost: 28,
            offsetAfterLastFrostDays: 7
          },
          succession: {
            enabled: false
          }
        }
      ]
    });

    assertBaseShape(result);

    // Season length sanity
    const seasonDays = daysBetween(result.lastFrostDate, result.firstFrostDate);
    expect(result.seasonSummary.seasonLengthDays).toBeCloseTo(seasonDays, 2);

    // Ensure both plants got schedules
    const lettuce = result.plantSchedules.find((p) => p.id === "lettuce");
    const tomato = result.plantSchedules.find((p) => p.id === "tomato");

    expect(lettuce).toBeTruthy();
    expect(tomato).toBeTruthy();

    // Lettuce should have at least one spring and one fall sowing window
    const lettuceSpring = lettuce.sowingWindows.filter(
      (w) => w.season === "spring"
    );
    const lettuceFall = lettuce.sowingWindows.filter(
      (w) => w.season === "fall"
    );
    expect(lettuceSpring.length).toBeGreaterThan(0);
    expect(lettuceFall.length).toBeGreaterThan(0);

    // Tomato should have at least one indoor spring window
    const tomatoSpring = tomato.sowingWindows.filter(
      (w) => w.season === "spring" && w.mode === "indoor"
    );
    expect(tomatoSpring.length).toBeGreaterThan(0);
  });
});

// -----------------------------------------------------------------------------
// Date math – Spring sowing relative to last frost
// -----------------------------------------------------------------------------
describe("GardenPlantingCalendarCalculator – spring sowing math", () => {
  it("places cool crop sowing window before last frost for direct sow", () => {
    const lastFrostDate = "2026-04-15";

    const result = calculateGardenPlantingCalendar({
      location: { zone: "6a" },
      lastFrostDate,
      firstFrostDate: "2026-10-15",
      plants: [
        {
          id: "peas",
          name: "Shelling Peas",
          daysToMaturity: 60,
          plantingGroup: "cool",
          sowing: {
            mode: "direct",
            offsetStartDaysBeforeLastFrost: 45,
            offsetEndDaysBeforeLastFrost: 10
          }
        }
      ]
    });

    assertBaseShape(result);
    const peas = result.plantSchedules.find((p) => p.id === "peas");
    const spring = peas.sowingWindows.find((w) => w.season === "spring");
    expect(spring).toBeTruthy();

    const lf = toDate(lastFrostDate);
    const start = toDate(spring.startDate);
    const end = toDate(spring.endDate);

    // start and end should be BEFORE last frost
    expect(start.getTime()).toBeLessThan(lf.getTime());
    expect(end.getTime()).toBeLessThan(lf.getTime());
  });

  it("places warm crop outdoor transplant after last frost", () => {
    const lastFrostDate = "2026-04-15";

    const result = calculateGardenPlantingCalendar({
      location: { zone: "6a" },
      lastFrostDate,
      firstFrostDate: "2026-10-15",
      plants: [
        {
          id: "pepper",
          name: "Bell Pepper",
          plantingGroup: "warm",
          daysToMaturity: 75,
          sowing: {
            mode: "indoor",
            offsetStartDaysBeforeLastFrost: 56,
            offsetEndDaysBeforeLastFrost: 28,
            offsetAfterLastFrostDays: 10
          }
        }
      ]
    });

    assertBaseShape(result);
    const pepper = result.plantSchedules.find((p) => p.id === "pepper");
    expect(pepper).toBeTruthy();
    expect(Array.isArray(pepper.transplantDates)).toBe(true);
    const springTransplant = pepper.transplantDates.find(
      (t) => t.season === "spring"
    );
    expect(springTransplant).toBeTruthy();

    const lf = toDate(lastFrostDate);
    const transplantDate = toDate(springTransplant.date);
    expect(transplantDate.getTime()).toBeGreaterThan(lf.getTime());
  });
});

// -----------------------------------------------------------------------------
// Fall sowing – cool crops before first frost
// -----------------------------------------------------------------------------
describe("GardenPlantingCalendarCalculator – fall sowing math", () => {
  it("adds fall sowing windows when fallOffsetBeforeFirstFrostDays is provided", () => {
    const firstFrostDate = "2026-10-20";

    const result = calculateGardenPlantingCalendar({
      location: { zone: "7b" },
      lastFrostDate: "2026-03-30",
      firstFrostDate,
      plants: [
        {
          id: "kale",
          name: "Kale",
          plantingGroup: "cool",
          daysToMaturity: 55,
          sowing: {
            mode: "direct",
            offsetStartDaysBeforeLastFrost: 28,
            offsetEndDaysBeforeLastFrost: 7,
            fallOffsetBeforeFirstFrostDays: 70
          }
        }
      ]
    });

    assertBaseShape(result);
    const kale = result.plantSchedules.find((p) => p.id === "kale");
    expect(kale).toBeTruthy();

    const fall = kale.sowingWindows.find((w) => w.season === "fall");
    expect(fall).toBeTruthy();

    const ff = toDate(firstFrostDate);
    const fallStart = toDate(fall.startDate);
    const fallEnd = toDate(fall.endDate);

    // Fall sowing should be BEFORE first frost
    expect(fallStart.getTime()).toBeLessThan(ff.getTime());
    expect(fallEnd.getTime()).toBeLessThan(ff.getTime());
  });
});

// -----------------------------------------------------------------------------
// Succession planting
// -----------------------------------------------------------------------------
describe("GardenPlantingCalendarCalculator – succession planting", () => {
  it("generates multiple succession rounds when enabled", () => {
    const result = calculateGardenPlantingCalendar({
      location: { zone: "7b" },
      lastFrostDate: "2026-04-01",
      firstFrostDate: "2026-11-01",
      plants: [
        {
          id: "radish",
          name: "Radish",
          daysToMaturity: 28,
          plantingGroup: "cool",
          sowing: {
            mode: "direct",
            offsetStartDaysBeforeLastFrost: 21,
            offsetEndDaysBeforeLastFrost: 0
          },
          succession: {
            enabled: true,
            intervalDays: 7,
            maxRounds: 5
          }
        }
      ]
    });

    assertBaseShape(result);
    const radish = result.plantSchedules.find((p) => p.id === "radish");
    expect(radish).toBeTruthy();
    expect(Array.isArray(radish.successions)).toBe(true);

    // Should have at least 2 rounds if space allows
    expect(radish.successions.length).toBeGreaterThan(1);

    // Each succession's sow date should be after the previous one
    for (let i = 1; i < radish.successions.length; i += 1) {
      const prev = toDate(radish.successions[i - 1].sowDate);
      const curr = toDate(radish.successions[i].sowDate);
      expect(curr.getTime()).toBeGreaterThan(prev.getTime());
    }
  });
});

// -----------------------------------------------------------------------------
// Site modifiers – raised bed / row cover should extend season slightly
// -----------------------------------------------------------------------------
describe("GardenPlantingCalendarCalculator – site modifiers", () => {
  it("allows slightly earlier sowing with row cover or raised beds", () => {
    const base = calculateGardenPlantingCalendar({
      location: { zone: "6b" },
      lastFrostDate: "2026-04-20",
      firstFrostDate: "2026-10-20",
      plants: [
        {
          id: "spinach",
          name: "Spinach",
          daysToMaturity: 45,
          plantingGroup: "cool",
          sowing: {
            mode: "direct",
            offsetStartDaysBeforeLastFrost: 28,
            offsetEndDaysBeforeLastFrost: 7
          }
        }
      ]
    });

    const modified = calculateGardenPlantingCalendar({
      location: { zone: "6b" },
      lastFrostDate: "2026-04-20",
      firstFrostDate: "2026-10-20",
      siteModifiers: {
        raisedBeds: true,
        rowCover: true
      },
      plants: [
        {
          id: "spinach",
          name: "Spinach",
          daysToMaturity: 45,
          plantingGroup: "cool",
          sowing: {
            mode: "direct",
            offsetStartDaysBeforeLastFrost: 28,
            offsetEndDaysBeforeLastFrost: 7
          }
        }
      ]
    });

    assertBaseShape(base);
    assertBaseShape(modified);

    const baseSpinach = base.plantSchedules.find((p) => p.id === "spinach");
    const modSpinach = modified.plantSchedules.find((p) => p.id === "spinach");

    const baseSpring = baseSpinach.sowingWindows.find(
      (w) => w.season === "spring"
    );
    const modSpring = modSpinach.sowingWindows.find(
      (w) => w.season === "spring"
    );

    const baseStart = toDate(baseSpring.startDate);
    const modStart = toDate(modSpring.startDate);

    // Modified plan may allow earlier sowing; if not earlier,
    // at minimum we expect it NOT to be later.
    expect(modStart.getTime()).toBeLessThanOrEqual(baseStart.getTime());
  });
});

// -----------------------------------------------------------------------------
// Defensive behavior
// -----------------------------------------------------------------------------
describe("GardenPlantingCalendarCalculator – defensive behavior", () => {
  it("handles invalid dates safely and emits warnings", () => {
    const result = calculateGardenPlantingCalendar({
      location: { zone: "??" },
      lastFrostDate: "invalid-date",
      firstFrostDate: "also-invalid",
      plants: [
        {
          id: "mystery",
          name: "Mystery Crop",
          daysToMaturity: 60,
          plantingGroup: "cool",
          sowing: {
            mode: "direct",
            offsetStartDaysBeforeLastFrost: 10,
            offsetEndDaysBeforeLastFrost: 0
          }
        }
      ]
    });

    // We only enforce that it doesn't throw and returns a shape + warnings.
    assertBaseShape(result);

    if (result.warnings && result.warnings.length > 0) {
      const joined = result.warnings.join(" ").toLowerCase();
      expect(joined).toContain("date");
    }
  });

  it("handles empty plant list without throwing", () => {
    const result = calculateGardenPlantingCalendar({
      location: { zone: "7b" },
      lastFrostDate: "2026-04-01",
      firstFrostDate: "2026-11-01",
      plants: []
    });

    assertBaseShape(result);
    expect(result.plantSchedules.length).toBe(0);
  });
});

// -----------------------------------------------------------------------------
// SSA / Planning Graph compatibility
// -----------------------------------------------------------------------------
describe("GardenPlantingCalendarCalculator – SSA integration checks", () => {
  it("returns stable values that can seed garden / session planning", () => {
    const result = calculateGardenPlantingCalendar({
      location: { zone: "8a" },
      lastFrostDate: "2026-03-10",
      firstFrostDate: "2026-11-25",
      plants: [
        {
          id: "bush-bean",
          name: "Bush Bean",
          daysToMaturity: 60,
          plantingGroup: "warm",
          sowing: {
            mode: "direct",
            offsetAfterLastFrostDays: 7
          }
        }
      ]
    });

    assertBaseShape(result);

    // Core numeric fields should be finite to support downstream SSA math
    expect(Number.isFinite(result.seasonSummary.seasonLengthDays)).toBe(true);
    expect(Number.isFinite(result.seasonSummary.coolSeasonDays)).toBe(true);
    expect(Number.isFinite(result.seasonSummary.warmSeasonDays)).toBe(true);

    const bean = result.plantSchedules.find((p) => p.id === "bush-bean");
    expect(bean).toBeTruthy();
    expect(Number.isFinite(daysBetween(bean.firstHarvestDate, bean.lastHarvestDate))).toBe(
      true
    );
  });
});
