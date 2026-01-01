// C:\Users\larho\suka-smart-assistant\src\features\calculators\calendar\ScripturalYearLengthCalculator\ScripturalYearLengthCalculator.hooks.js

/**
 * ScripturalYearLengthCalculator.hooks.js
 *
 * How this fits:
 * - Provides shared hooks for consuming the Scriptural Year Length calculator
 *   across SSA:
 *   - Garden planning (seasons, sowing / harvest windows).
 *   - Curriculum planning (terms / blocks tied to the scriptural year).
 *   - Household “stability” signal (consistency of year pattern).
 *
 * - Hooks here do **not** run a SessionRunner themselves.
 *   - They build signals (seasonBuckets, curriculumTerms, stabilityScore)
 *     that other planners and session-shims can consume to create runnable
 *     sessions (cooking / cleaning / garden / preservation / storehouse).
 *
 * Events:
 * - Listens to:
 *   - planningGraph.calculator.succeeded
 *       data: { moduleId, output }
 *       where moduleId === "calendar.ScripturalYearLengthCalculator"
 * - Emits:
 *   - planningGraph.yearStructure.updated
 *   - planningGraph.yearStructure.gardenMapped
 *   - planningGraph.yearStructure.curriculumMapped
 */

import { useEffect, useMemo, useState } from "react";
import { emit as emitEvent, subscribe as subscribeToEventBus } from "@/services/eventBus";
import { familyFundMode } from "@/services/featureFlags";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const safeSubscribe =
  typeof subscribeToEventBus === "function"
    ? subscribeToEventBus
    // Fallback no-op subscription if subscribe is not yet implemented.
    : () => () => {};

/**
 * Derive simple season buckets from an ordered list of scriptural months.
 *
 * @param {Array<{
 *  index: number,
 *  name: string,
 *  startDate: string,
 *  endDate: string,
 *  days: number,
 *  isIntercalary?: boolean
 * }>} months
 */
function buildSeasonBucketsFromMonths(months) {
  if (!Array.isArray(months) || months.length === 0) {
    return {
      spring: [],
      earlyHarvest: [],
      lateHarvest: [],
      storageRest: [],
      intercalary: [],
    };
  }

  const spring = [];
  const earlyHarvest = [];
  const lateHarvest = [];
  const storageRest = [];
  const intercalary = [];

  for (const m of months) {
    if (m.isIntercalary) {
      intercalary.push(m);
      continue;
    }

    if (m.index >= 1 && m.index <= 3) {
      spring.push(m);
    } else if (m.index >= 4 && m.index <= 6) {
      earlyHarvest.push(m);
    } else if (m.index >= 7 && m.index <= 9) {
      lateHarvest.push(m);
    } else {
      storageRest.push(m);
    }
  }

  return {
    spring,
    earlyHarvest,
    lateHarvest,
    storageRest,
    intercalary,
  };
}

/**
 * Simple curriculum term mapping.
 * - Term 1 → spring
 * - Term 2 → early harvest
 * - Term 3 → late harvest
 * - Term 4 (optional) → storage/rest
 */
function buildCurriculumTermsFromSeasons(yearLabel, seasonBuckets) {
  const terms = [];
  let order = 1;

  const addIfAny = (label, bucketKey) => {
    const bucket = seasonBuckets[bucketKey] || [];
    if (!bucket.length) return;
    terms.push({
      termNumber: order++,
      termLabel: `${yearLabel} – ${label}`,
      seasonKey: bucketKey,
      months: bucket.map((m) => m.name),
      startDate: bucket[0]?.startDate || null,
      endDate: bucket[bucket.length - 1]?.endDate || null,
    });
  };

  addIfAny("Spring Term", "spring");
  addIfAny("Early Harvest Term", "earlyHarvest");
  addIfAny("Late Harvest Term", "lateHarvest");
  addIfAny("Storehouse / Rest Term", "storageRest");

  return terms;
}

/**
 * Very simple “stability” heuristic:
 * - Stable if:
 *   - daysInYear remains between 353 and 366 (inclusive).
 *   - months length is 12 or 13.
 *
 * Returns a number between 0 and 1.
 */
function computeStabilityScore(daysInYear, monthsCount) {
  if (!daysInYear || !monthsCount) return 0.3;

  const daysStable = daysInYear >= 353 && daysInYear <= 366;
  const monthsStable = monthsCount === 12 || monthsCount === 13;

  if (daysStable && monthsStable) return 0.95;
  if (daysStable || monthsStable) return 0.7;
  return 0.4;
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

/**
 * useLatestScripturalYearFromEvents
 *
 * Listens to planningGraph.calculator.succeeded for this module and
 * stores the latest year structure so any consumer can read it.
 *
 * @returns {{
 *   year: null | {
 *     yearLabel: string,
 *     daysInYear: number,
 *     isLeapYear: boolean,
 *     anchorDates: { yearStart?: string, midYearMarker?: string, yearEnd?: string },
 *     months: Array
 *   },
 *   lastUpdated: string | null
 * }}
 */
export function useLatestScripturalYearFromEvents() {
  const [year, setYear] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);

  useEffect(() => {
    const unsubscribe = safeSubscribe((evt) => {
      if (
        !evt ||
        evt.type !== "planningGraph.calculator.succeeded" ||
        !evt.data ||
        evt.data.moduleId !== "calendar.ScripturalYearLengthCalculator"
      ) {
        return;
      }

      const output = evt.data.output;
      if (!output) return;

      setYear(output);
      setLastUpdated(evt.ts || new Date().toISOString());

      emitEvent({
        type: "planningGraph.yearStructure.updated",
        ts: new Date().toISOString(),
        source: "calendar.ScripturalYearLengthCalculator.hooks",
        data: {
          yearLabel: output.yearLabel,
          daysInYear: output.daysInYear,
          isLeapYear: output.isLeapYear,
          monthsCount: Array.isArray(output.months) ? output.months.length : 0,
          anchorDates: output.anchorDates || {},
          familyFundMode,
        },
      });
    });

    return () => {
      if (typeof unsubscribe === "function") unsubscribe();
    };
  }, []);

  return { year, lastUpdated };
}

/**
 * useScripturalYearForGarden
 *
 * Consumes the year object (either from the calculator view or from
 * useLatestScripturalYearFromEvents) and exposes season buckets + a
 * stability score useful for garden & storehouse planning.
 *
 * @param {object|null} year
 */
export function useScripturalYearForGarden(year) {
  const seasonBuckets = useMemo(
    () => buildSeasonBucketsFromMonths(year?.months || []),
    [year]
  );

  const stabilityScore = useMemo(
    () =>
      computeStabilityScore(
        year?.daysInYear || 0,
        Array.isArray(year?.months) ? year.months.length : 0
      ),
    [year]
  );

  useEffect(() => {
    if (!year) return;

    emitEvent({
      type: "planningGraph.yearStructure.gardenMapped",
      ts: new Date().toISOString(),
      source: "calendar.ScripturalYearLengthCalculator.hooks",
      data: {
        yearLabel: year.yearLabel,
        stabilityScore,
        seasonBuckets: {
          springCount: seasonBuckets.spring.length,
          earlyHarvestCount: seasonBuckets.earlyHarvest.length,
          lateHarvestCount: seasonBuckets.lateHarvest.length,
          storageRestCount: seasonBuckets.storageRest.length,
          intercalaryCount: seasonBuckets.intercalary.length,
        },
        familyFundMode,
      },
    });
  }, [year, stabilityScore, seasonBuckets]);

  /**
   * “Next” garden windows that a planner might anchor:
   * - sowingWindow: spring months
   * - mainHarvestWindow: early + late harvest months
   * - storageWindow: storage/rest months
   */
  const nextGardenWindows = useMemo(() => {
    const sowing = [...seasonBuckets.spring];
    const harvest = [...seasonBuckets.earlyHarvest, ...seasonBuckets.lateHarvest];
    const storage = [...seasonBuckets.storageRest];

    return {
      sowingWindow: sowing,
      mainHarvestWindow: harvest,
      storageWindow: storage,
    };
  }, [seasonBuckets]);

  return {
    seasonBuckets,
    stabilityScore,
    nextGardenWindows,
  };
}

/**
 * useScripturalYearCurriculumTerms
 *
 * Map the year layout into curriculum terms / blocks for the
 * education system (e.g., 3–4 scriptural terms instead of 2
 * “semesters” or 4 artificial quarters).
 *
 * @param {object|null} year
 */
export function useScripturalYearCurriculumTerms(year) {
  const seasonBuckets = useMemo(
    () => buildSeasonBucketsFromMonths(year?.months || []),
    [year]
  );

  const terms = useMemo(() => {
    if (!year) return [];
    return buildCurriculumTermsFromSeasons(year.yearLabel, seasonBuckets);
  }, [year, seasonBuckets]);

  useEffect(() => {
    if (!year || !terms.length) return;

    emitEvent({
      type: "planningGraph.yearStructure.curriculumMapped",
      ts: new Date().toISOString(),
      source: "calendar.ScripturalYearLengthCalculator.hooks",
      data: {
        yearLabel: year.yearLabel,
        terms: terms.map((t) => ({
          termNumber: t.termNumber,
          termLabel: t.termLabel,
          seasonKey: t.seasonKey,
          startDate: t.startDate,
          endDate: t.endDate,
          months: t.months,
        })),
        familyFundMode,
      },
    });
  }, [year, terms]);

  return terms;
}

/**
 * useScripturalYearStabilitySignal
 *
 * Tiny hook that wraps the stability score only, so other modules
 * (session generators, inventory guards, etc.) can use it to
 * adjust aggressiveness of suggestions.
 *
 * @param {object|null} year
 */
export function useScripturalYearStabilitySignal(year) {
  return useMemo(
    () =>
      computeStabilityScore(
        year?.daysInYear || 0,
        Array.isArray(year?.months) ? year.months.length : 0
      ),
    [year]
  );
}
