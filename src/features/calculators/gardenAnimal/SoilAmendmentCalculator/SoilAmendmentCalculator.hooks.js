// C:\Users\larho\suka-smart-assistant\src\features\calculators\gardenAnimal\SoilAmendmentCalculator\SoilAmendmentCalculator.hooks.js

import { useMemo, useEffect } from "react";
import { emit } from "@/services/events/eventBus";

/**
 * SoilAmendmentCalculator.hooks
 *
 * HOW THIS FITS:
 * - These hooks sit between the SoilAmendmentCalculator payload and the rest
 *   of the Planning Graph (especially GardenYieldCalculator and stability /
 *   resilience analytics).
 * - They do NOT perform the soil amendment calculations themselves; that is
 *   handled by SoilAmendmentCalculator.shim.js.
 * - Instead, they:
 *   1) Read the soil & amendment outputs.
 *   2) Derive stability + yield modifiers per bed and overall.
 *   3) Optionally emit events so GardenYieldCalculator, storehouse, or
 *      dashboards can use those derived hints.
 *
 * KEY IDEAS:
 * - Stability is a qualitative view of how robust each bed is:
 *   “fragile” → “developing” → “stable”.
 * - Yield modifiers are numeric hints (0.6–1.15) that the GardenYield
 *   calculator can use to modulate expected harvest amounts based on soil.
 * - Nothing here is session-specific; but its outputs can be used to bias
 *   which garden / amendment / harvest sessions SessionRunner proposes next.
 */

/**
 * @typedef {Object} SoilAmendmentPayload
 * @property {{ nodeKey?: string; version?: string; runId?: string }} [context]
 * @property {{
 *   soilProfile?: {
 *     defaultTexture?: string;
 *     beds?: Array<{
 *       bedId?: string;
 *       name?: string;
 *       texture?: string;
 *       organicMatterPct?: number;
 *       drainage?: "poor" | "moderate" | "fast" | string;
 *       areaSqFt?: number;
 *       depthInches?: number;
 *     }>;
 *   };
 *   soilTests?: Array<{
 *     testId?: string;
 *     bedId?: string;
 *     takenAt?: string;
 *     ph?: number;
 *     nPpm?: number;
 *     pPpm?: number;
 *     kPpm?: number;
 *     caPpm?: number;
 *     mgPpm?: number;
 *   }>;
 *   targetFertility?: {
 *     phMin?: number;
 *     phMax?: number;
 *     nMin?: number;
 *     nMax?: number;
 *     pMin?: number;
 *     pMax?: number;
 *     kMin?: number;
 *     kMax?: number;
 *   };
 *   gardenLayout?: {
 *     beds?: Array<{
 *       bedId?: string;
 *       name?: string;
 *       areaSqFt?: number;
 *       depthInches?: number;
 *     }>;
 *   };
 * }} [inputs]
 * @property {{
 *   amendmentPlan?: Array<{
 *     planId?: string;
 *     bedId?: string;
 *     materialKey?: string;
 *     materialName?: string;
 *     materialUnit?: string;
 *     ratePerSqFt?: number;
 *     totalAmount?: number;
 *     priority?: "low" | "medium" | "high" | "critical" | string;
 *   }>;
 *   amendmentSessions?: Array<{
 *     sessionId?: string;
 *     title?: string;
 *     bedIds?: string[];
 *     estimatedDurationSec?: number;
 *   }>;
 *   amendmentSummary?: {
 *     totalBeds?: number;
 *     totalMaterials?: number;
 *     totalSessions?: number;
 *     estimatedTotalLaborMinutes?: number;
 *     notes?: string;
 *     version?: string;
 *   };
 * }} [outputs]
 */

/**
 * @typedef {Object} SoilStabilityPerBed
 * @property {string} bedId
 * @property {string} bedName
 * @property {number} soilScore           // 0–100
 * @property {"fragile"|"developing"|"stable"} stabilityRating
 * @property {number} yieldModifier       // ~0.6–1.15
 * @property {string} limitingFactor      // human-readable explanation
 * @property {number | null} organicMatterPct
 * @property {number | null} ph
 * @property {string | null} drainage
 */

/**
 * @typedef {Object} SoilStabilityOverall
 * @property {number} areaWeightedScore
 * @property {"fragile"|"developing"|"stable"} stabilityRating
 * @property {number} yieldModifier
 * @property {string[]} globalConcerns
 */

/**
 * @typedef {Object} SoilStabilityResult
 * @property {SoilStabilityPerBed[]} perBed
 * @property {SoilStabilityOverall} overall
 */

/**
 * @typedef {Object} UseSoilStabilityOptions
 * @property {boolean} [autoEmitEvents]           // default true
 * @property {string} [eventSource]               // default "calculators/SoilAmendmentCalculator"
 */

/**
 * useSoilStabilityFromAmendments
 *
 * - Computes bed-level soil scores, stability ratings, and yield modifiers.
 * - Computes an area-weighted overall stability & yield modifier.
 * - Optionally emits "soilAmendment.stability.updated" whenever the derived
 *   picture changes (used by yield / harvest planning and dashboards).
 *
 * @param {SoilAmendmentPayload | null | undefined} payload
 * @param {UseSoilStabilityOptions} [options]
 * @returns {SoilStabilityResult}
 */
export function useSoilStabilityFromAmendments(payload, options = {}) {
  const {
    autoEmitEvents = true,
    eventSource = "calculators/SoilAmendmentCalculator",
  } = options;

  const result = useMemo(() => {
    const empty = /** @type {SoilStabilityResult} */ ({
      perBed: [],
      overall: {
        areaWeightedScore: 0,
        stabilityRating: "fragile",
        yieldModifier: 0.75,
        globalConcerns: [],
      },
    });

    if (!payload || !payload.inputs) return empty;

    const inputs = payload.inputs;
    const soilProfile = inputs.soilProfile || {};
    const soilBeds = Array.isArray(soilProfile.beds) ? soilProfile.beds : [];
    const soilTests = Array.isArray(inputs.soilTests) ? inputs.soilTests : [];
    const target = inputs.targetFertility || {};
    const gardenLayout = inputs.gardenLayout || {};
    const layoutBeds = Array.isArray(gardenLayout.beds)
      ? gardenLayout.beds
      : [];

    // quick lookup
    const testsByBedId = groupTestsByBedId(soilTests);
    const layoutByBedId = new Map();
    layoutBeds.forEach((b) => {
      if (!b || !b.bedId) return;
      layoutByBedId.set(String(b.bedId), b);
    });

    /** @type {SoilStabilityPerBed[]} */
    const perBed = [];

    let totalArea = 0;
    let weightedScoreSum = 0;
    let weightedYieldModifierSum = 0;
    /** @type {Set<string>} */
    const globalConcerns = new Set();

    soilBeds.forEach((bedRaw) => {
      if (!bedRaw) return;
      const bedId = String(bedRaw.bedId || "");
      const layoutBed = layoutByBedId.get(bedId);
      const area = safeNumber(layoutBed?.areaSqFt, 0);
      const bedName = bedRaw.name || layoutBed?.name || `Bed ${bedId || "?"}`;

      const effectiveTexture =
        bedRaw.texture || soilProfile.defaultTexture || "loam";
      const organicMatterPct =
        typeof bedRaw.organicMatterPct === "number"
          ? bedRaw.organicMatterPct
          : null;
      const drainage = bedRaw.drainage || "moderate";

      const tests = testsByBedId.get(bedId) || [];
      const latestTest = chooseLatestTest(tests);
      const ph = typeof latestTest?.ph === "number" ? latestTest.ph : null;

      const targetPhMin = typeof target.phMin === "number" ? target.phMin : 6.2;
      const targetPhMax = typeof target.phMax === "number" ? target.phMax : 6.8;

      const { score, limitingFactor, yieldModifier, stabilityRating } =
        computeBedScore({
          texture: effectiveTexture,
          organicMatterPct,
          drainage,
          ph,
          targetPhMin,
          targetPhMax,
        });

      perBed.push({
        bedId,
        bedName,
        soilScore: score,
        stabilityRating,
        yieldModifier,
        limitingFactor,
        organicMatterPct,
        ph,
        drainage,
      });

      if (area > 0) {
        totalArea += area;
        weightedScoreSum += score * area;
        weightedYieldModifierSum += yieldModifier * area;
      }

      if (limitingFactor) {
        globalConcerns.add(limitingFactor);
      }
    });

    let areaWeightedScore = 0;
    let overallYieldModifier = 0.75;

    if (totalArea > 0) {
      areaWeightedScore = weightedScoreSum / totalArea;
      overallYieldModifier = weightedYieldModifierSum / totalArea;
    } else if (perBed.length > 0) {
      // Fallback if no areas defined
      const avgScore =
        perBed.reduce((acc, b) => acc + (b.soilScore || 0), 0) /
        (perBed.length || 1);
      areaWeightedScore = avgScore;
      overallYieldModifier =
        perBed.reduce((acc, b) => acc + (b.yieldModifier || 0), 0) /
        (perBed.length || 1);
    }

    const overallStabilityRating = classifyStability(areaWeightedScore);

    /** @type {SoilStabilityResult} */
    const result = {
      perBed,
      overall: {
        areaWeightedScore,
        stabilityRating: overallStabilityRating,
        yieldModifier: clamp(overallYieldModifier, 0.5, 1.25),
        globalConcerns: Array.from(globalConcerns),
      },
    };

    return result;
  }, [payload]);

  // optional event bridge → can be consumed by GardenYieldCalculator, dashboards, etc.
  useEffect(() => {
    if (!autoEmitEvents) return;
    if (!payload) return;

    try {
      emit({
        type: "soilAmendment.stability.updated",
        ts: new Date().toISOString(),
        source: options.eventSource || "calculators/SoilAmendmentCalculator",
        data: {
          context: payload.context || {},
          stability: result,
        },
      });
    } catch (err) {
      // Fail-soft; never break UI because of event bus issues
      // eslint-disable-next-line no-console
      console.warn(
        "[SoilAmendmentCalculator] Failed to emit stability event",
        err
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    autoEmitEvents,
    payload && payload.context && payload.context.runId,
    result.overall.areaWeightedScore,
    result.overall.yieldModifier,
    result.perBed.length,
  ]);

  return result;
}

/**
 * useSoilYieldHintsForGarden
 *
 * Convenience hook that converts the stability result into a shape that the
 * GardenYieldCalculator can use directly as "soilHints" or "soilModifiers".
 *
 * This keeps the GardenYieldCalculator free from soil-specific logic while
 * still letting it factor soil improvements into its harvest predictions.
 *
 * @param {SoilAmendmentPayload | null | undefined} payload
 * @returns {{
 *   perBed: Array<{
 *     bedId: string;
 *     yieldModifier: number;
 *     stabilityRating: "fragile"|"developing"|"stable";
 *   }>;
 *   overallYieldModifier: number;
 *   stabilityRating: "fragile"|"developing"|"stable";
 * }}
 */
export function useSoilYieldHintsForGarden(payload) {
  const stability = useSoilStabilityFromAmendments(payload, {
    autoEmitEvents: false,
  });

  return useMemo(
    () => ({
      perBed: stability.perBed.map((b) => ({
        bedId: b.bedId,
        yieldModifier: b.yieldModifier,
        stabilityRating: b.stabilityRating,
      })),
      overallYieldModifier: stability.overall.yieldModifier,
      stabilityRating: stability.overall.stabilityRating,
    }),
    [stability]
  );
}

// ---------------------------------------------------------------------------
// Internal helpers (pure functions, safe to share with other modules)
// ---------------------------------------------------------------------------

/**
 * @param {Array<any>} tests
 * @returns {Map<string, any[]>}
 */
function groupTestsByBedId(tests) {
  const map = new Map();
  tests.forEach((t) => {
    if (!t || !t.bedId) return;
    const key = String(t.bedId);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(t);
  });
  return map;
}

/**
 * Choose the latest test by takenAt ISO date.
 * @param {any[]} tests
 * @returns {any | null}
 */
function chooseLatestTest(tests) {
  if (!Array.isArray(tests) || tests.length === 0) return null;
  let latest = tests[0];
  let latestTs = latest?.takenAt ? Date.parse(latest.takenAt) : 0;
  for (let i = 1; i < tests.length; i += 1) {
    const t = tests[i];
    if (!t) continue;
    const ts = t.takenAt ? Date.parse(t.takenAt) : 0;
    if (ts > latestTs) {
      latest = t;
      latestTs = ts;
    }
  }
  return latest;
}

/**
 * Compute a 0–100 soil score + yieldModifier and limiting factor for a bed.
 *
 * Simple heuristic model (tunable later, but stable for now):
 * - Organic matter (0–40 pts)
 * - pH (0–40 pts)
 * - Drainage (0–20 pts)
 *
 * Score → stability & yield:
 * - <= 40 → "fragile", yieldModifier 0.6–0.85
 * - 40–70 → "developing", yieldModifier 0.85–1.0
 * - > 70  → "stable", yieldModifier 1.0–1.15
 *
 * @param {{
 *   texture: string;
 *   organicMatterPct: number | null;
 *   drainage: string | null;
 *   ph: number | null;
 *   targetPhMin: number;
 *   targetPhMax: number;
 * }} params
 */
function computeBedScore(params) {
  const { texture, organicMatterPct, drainage, ph, targetPhMin, targetPhMax } =
    params;

  // 1) Organic matter 0–40
  let omScore = 0;
  let omConcern = "";
  if (typeof organicMatterPct === "number") {
    if (organicMatterPct < 2) {
      omScore = 10;
      omConcern = "low organic matter";
    } else if (organicMatterPct < 4) {
      omScore = 25;
      omConcern = "moderate organic matter";
    } else if (organicMatterPct < 7) {
      omScore = 35;
    } else {
      omScore = 40;
    }
  } else {
    omScore = 20;
    omConcern = "unknown organic matter";
  }

  // 2) pH 0–40
  let phScore = 0;
  let phConcern = "";
  if (typeof ph === "number") {
    if (ph >= targetPhMin && ph <= targetPhMax) {
      phScore = 40;
    } else {
      const center = (targetPhMin + targetPhMax) / 2;
      const delta = Math.abs(ph - center);
      if (delta <= 0.3) {
        phScore = 35;
      } else if (delta <= 0.7) {
        phScore = 28;
        phConcern = "pH slightly off target range";
      } else if (delta <= 1.2) {
        phScore = 18;
        phConcern = "pH moderately off target range";
      } else {
        phScore = 8;
        phConcern = "pH far from target range";
      }
    }
  } else {
    phScore = 20;
    phConcern = "unknown pH";
  }

  // 3) Drainage 0–20
  let drainageScore = 0;
  let drainageConcern = "";
  const d = (drainage || "").toLowerCase();
  if (d === "moderate") {
    drainageScore = 20;
  } else if (d === "fast" || d === "well-drained") {
    drainageScore = 16;
    drainageConcern = "fast drainage (monitor moisture)";
  } else if (d === "poor" || d === "heavy") {
    drainageScore = 10;
    drainageConcern = "poor drainage (risk of waterlogging)";
  } else {
    drainageScore = 14;
  }

  let limitingFactor = "";
  if (phConcern) limitingFactor = phConcern;
  if (omConcern && (!limitingFactor || omScore < phScore))
    limitingFactor = omConcern;
  if (drainageConcern && (!limitingFactor || drainageScore < omScore)) {
    limitingFactor = drainageConcern;
  }
  if (!limitingFactor) {
    if ((texture || "").includes("sand")) {
      limitingFactor = "sandy soil may require more frequent feeding";
    } else if ((texture || "").includes("clay")) {
      limitingFactor = "clay soil may need more organic matter and aeration";
    }
  }

  const score = clamp(omScore + phScore + drainageScore, 0, 100);
  const stabilityRating = classifyStability(score);
  const yieldModifier = computeYieldModifierFromScore(score);

  return {
    score,
    limitingFactor,
    yieldModifier,
    stabilityRating,
  };
}

/**
 * @param {number} score
 * @returns {"fragile"|"developing"|"stable"}
 */
function classifyStability(score) {
  if (score <= 40) return "fragile";
  if (score <= 70) return "developing";
  return "stable";
}

/**
 * @param {number} score 0–100
 * @returns {number}
 */
function computeYieldModifierFromScore(score) {
  // Piecewise linear for now:
  // 0–40 → 0.6–0.85
  // 40–70 → 0.85–1.0
  // 70–100 → 1.0–1.15
  const s = clamp(score, 0, 100);
  if (s <= 40) {
    const t = s / 40; // 0–1
    return 0.6 + t * (0.85 - 0.6);
  }
  if (s <= 70) {
    const t = (s - 40) / 30; // 0–1
    return 0.85 + t * (1.0 - 0.85);
  }
  const t = (s - 70) / 30; // 0–1
  return 1.0 + t * (1.15 - 1.0);
}

/**
 * @param {any} v
 * @param {number} [fallback]
 */
function safeNumber(v, fallback = 0) {
  if (v === null || v === undefined || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * @param {number} v
 * @param {number} min
 * @param {number} max
 */
function clamp(v, min, max) {
  if (v < min) return min;
  if (v > max) return max;
  return v;
}
