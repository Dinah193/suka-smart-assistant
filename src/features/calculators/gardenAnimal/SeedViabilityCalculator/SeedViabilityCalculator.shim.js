// C:\Users\larho\suka-smart-assistant\src\features\calculators\gardenAnimal\SeedViabilityCalculator\SeedViabilityCalculator.shim.js

/**
 * SeedViabilityCalculator.shim.js
 *
 * Shim logic for the Seed Viability Calculator Planning Graph node.
 *
 * Responsibilities:
 * - Accept a structured payload (see SeedViabilityCalculator.schema.json).
 * - Estimate germination rate and viability score for each seed lot.
 * - Suggest sowing rate multipliers and replacement status.
 * - Emit Planning Graph–friendly output plus optional Hub export when familyFundMode is enabled.
 *
 * This shim DOES NOT:
 * - Talk directly to UI (that’s handled by SeedViabilityCalculator.view.jsx).
 * - Manage sessions or timers (SessionRunner covers that).
 */

import { emit } from "@/services/eventBus";
import { familyFundMode } from "@/services/featureFlags";
import { HubPacketFormatter, FamilyFundConnector } from "@/services/hub";

const SHIM_SOURCE = "features/calculators/gardenAnimal/SeedViabilityCalculator.shim";

/**
 * @typedef {import("./SeedViabilityCalculator.types").SeedViabilityPayload} SeedViabilityPayload
 * @typedef {import("./SeedViabilityCalculator.types").SeedViabilityResult} SeedViabilityResult
 *
 * NOTE: If SeedViabilityCalculator.types.js does not exist yet, you can
 * safely ignore these typedefs or create a small types helper file later.
 */

/**
 * Entry point: main shim function invoked by the Planning Graph runtime.
 *
 * @param {SeedViabilityPayload} payload
 * @returns {Promise<SeedViabilityResult>}
 */
export async function runSeedViabilityCalculatorShim(payload) {
  const ts = new Date().toISOString();

  if (!payload || typeof payload !== "object") {
    const errorResult = {
      meta: {
        ok: false,
        reason: "invalid-payload",
        message: "SeedViabilityCalculator shim received an invalid payload.",
        evaluatedAt: ts
      },
      lots: []
    };
    emit({
      type: "planningGraph.seedViability.error",
      ts,
      source: SHIM_SOURCE,
      data: { payloadSummary: summarizePayload(payload), error: errorResult.meta }
    });
    return errorResult;
  }

  const seedLots = Array.isArray(payload.seedLots) ? payload.seedLots : [];
  const environment = payload.environment || {};
  const planningHints = payload.planningHints || {};

  const results = seedLots.map((lot) =>
    evaluateSeedLot(lot, environment, planningHints)
  );

  const summary = buildSummary(results, planningHints);

  const result = {
    meta: {
      ok: true,
      evaluatedAt: ts,
      lotCount: results.length,
      highRiskLotCount: summary.highRiskLotCount,
      replaceNowCount: summary.replaceNowCount
    },
    lots: results
  };

  emit({
    type: "planningGraph.seedViability.completed",
    ts,
    source: SHIM_SOURCE,
    data: {
      meta: result.meta,
      // Keep per-lot data trimmed for event payload
      lots: results.map((r) => ({
        id: r.id,
        crop: r.crop,
        viabilityScore: r.viabilityScore,
        estimatedGerminationRate: r.estimatedGerminationRate,
        sowRateMultiplier: r.sowRateMultiplier,
        recommendedStatus: r.recommendedStatus,
        riskFlags: r.riskFlags
      }))
    }
  });

  // Optional hub export
  if (familyFundMode) {
    tryExportToHub(ts, result, planningHints).catch((err) => {
      // Fail silently, but log to eventBus
      emit({
        type: "hub.export.seedViability.error",
        ts: new Date().toISOString(),
        source: SHIM_SOURCE,
        data: { errorMessage: String(err) }
      });
    });
  }

  return result;
}

/**
 * Evaluate a single seed lot and produce viability metrics.
 *
 * @param {any} lot
 * @param {any} environment
 * @param {any} planningHints
 * @returns {import("./SeedViabilityCalculator.types").SeedViabilityLotResult}
 */
function evaluateSeedLot(lot, environment, planningHints) {
  const safeLot = lot && typeof lot === "object" ? lot : {};
  const id = String(safeLot.id || "");
  const crop = String(safeLot.crop || "");

  const ageCategory = safeLot.ageCategory || inferAgeCategory(safeLot);
  const storageProfile = safeLot.storageProfile || {};
  const germinationTest = safeLot.germinationTest || {};
  const planning = safeLot.planning || {};
  const computed = safeLot.computed || {};

  // 1. Base germination estimate from age
  let baseGermPct = estimateBaseGermFromAge(ageCategory);

  // 2. Adjust for storage quality
  const storageScore = estimateStorageQuality(storageProfile, computed);
  baseGermPct *= storageScore / 100;

  // 3. Apply germination test override/fine-tuning if present
  const testAdjustedPct = adjustForGerminationTest(baseGermPct, germinationTest);

  // 4. Clamp between 0 and 100
  const estimatedGerminationRate = clamp(testAdjustedPct, 0, 100);

  // 5. Map to viability score (can be same scale, slightly weighted)
  const viabilityScore = clamp(
    (estimatedGerminationRate * 0.7) + (storageScore * 0.3),
    0,
    100
  );

  // 6. Determine sowing multiplier and recommended status
  const { sowRateMultiplier, recommendedStatus, riskFlags } = deriveSowRateAndStatus(
    viabilityScore,
    estimatedGerminationRate,
    planning,
    planningHints
  );

  const notes = buildNotesForLot({
    ageCategory,
    storageProfile,
    germinationTest,
    viabilityScore,
    estimatedGerminationRate,
    sowRateMultiplier,
    recommendedStatus
  });

  const nextActions = buildNextActionsForLot({
    recommendedStatus,
    planning,
    planningHints
  });

  return {
    id,
    crop,
    variety: safeLot.variety || null,
    viabilityScore,
    estimatedGerminationRate,
    sowRateMultiplier,
    recommendedStatus,
    storageQualityScore: storageScore,
    riskFlags,
    notes,
    nextActions,
    raw: { lot: safeLot, environment, planningHints }
  };
}

/**
 * Infer age category if not explicitly set.
 * Fallback: assume "1-2-years" for unknown, but you can tighten this later.
 */
function inferAgeCategory(lot) {
  if (lot.ageCategory) return lot.ageCategory;

  const packedYear = lot.packedForYear;
  const harvestedAt = lot.harvestedAt;
  const nowYear = new Date().getFullYear();

  let approxYears = null;

  if (typeof packedYear === "number") {
    approxYears = nowYear - packedYear;
  } else if (typeof harvestedAt === "string") {
    const d = new Date(harvestedAt);
    if (!Number.isNaN(d.getTime())) {
      approxYears = nowYear - d.getFullYear();
    }
  }

  if (approxYears == null) return "1-2-years";
  if (approxYears <= 1) return "fresh";
  if (approxYears <= 2) return "1-2-years";
  if (approxYears <= 4) return "3-4-years";
  return "5+-years";
}

/**
 * Estimate base germination from age category alone.
 */
function estimateBaseGermFromAge(ageCategory) {
  switch (ageCategory) {
    case "fresh":
      return 95;
    case "1-2-years":
      return 90;
    case "3-4-years":
      return 75;
    case "5+-years":
      return 50;
    default:
      return 80;
  }
}

/**
 * Estimate storage quality score 0–100.
 */
function estimateStorageQuality(storageProfile, computed) {
  // If pre-computed is available, prefer it with light smoothing.
  if (
    computed &&
    typeof computed.storageQualityScore === "number" &&
    computed.storageQualityScore >= 0 &&
    computed.storageQualityScore <= 100
  ) {
    return computed.storageQualityScore;
  }

  if (!storageProfile || typeof storageProfile !== "object") {
    return 60; // Conservative default
  }

  let score = 50;

  if (storageProfile.sealed) score += 15;
  if (storageProfile.cool) score += 10;
  if (storageProfile.dark) score += 10;
  if (storageProfile.dry) score += 10;
  if (storageProfile.freezerStored) score += 10;

  const avgTempC = storageProfile.avgTempC;
  if (typeof avgTempC === "number") {
    if (avgTempC < 5 || avgTempC > 30) score -= 10;
    else if (avgTempC >= 5 && avgTempC <= 18) score += 5;
  }

  const avgHumidityPct = storageProfile.avgHumidityPct;
  if (typeof avgHumidityPct === "number") {
    if (avgHumidityPct > 70) score -= 10;
    else if (avgHumidityPct >= 30 && avgHumidityPct <= 55) score += 5;
  }

  return clamp(score, 10, 100);
}

/**
 * Incorporate germination test data into the estimated germination rate.
 */
function adjustForGerminationTest(baseGermPct, germinationTest) {
  if (
    !germinationTest ||
    typeof germinationTest !== "object" ||
    !germinationTest.performed
  ) {
    return baseGermPct;
  }

  const seedsTested = germinationTest.seedsTested || 0;
  const seedsGerminated = germinationTest.seedsGerminated || 0;

  if (seedsTested > 0 && seedsGerminated >= 0) {
    const observedRate = (seedsGerminated / seedsTested) * 100;
    // Blend observed with base to avoid wild swings on tiny samples
    const weight = seedsTested >= 20 ? 0.8 : 0.5;
    return baseGermPct * (1 - weight) + observedRate * weight;
  }

  // If test has qualitative issues but no counts, gently adjust down.
  const issues = Array.isArray(germinationTest.observedIssues)
    ? germinationTest.observedIssues
    : [];

  if (issues.includes("mold")) return baseGermPct * 0.7;
  if (issues.includes("weak-seedlings")) return baseGermPct * 0.8;
  if (issues.includes("slow-germination")) return baseGermPct * 0.85;

  return baseGermPct;
}

/**
 * Determine sowing multiplier and status based on viability and context.
 */
function deriveSowRateAndStatus(
  viabilityScore,
  estimatedGerminationRate,
  planning,
  planningHints
) {
  const priority = planning?.priority || "important";
  const isStaple = priority === "staple";

  const storehouseProfile = planningHints?.storehouseGoalProfile || {};
  const staplePriorityFactor =
    typeof storehouseProfile.staplePriorityFactor === "number"
      ? storehouseProfile.staplePriorityFactor
      : 1.0;
  const minimumViabilityForStaples =
    typeof storehouseProfile.minimumViabilityForStaples === "number"
      ? storehouseProfile.minimumViabilityForStaples
      : 70;

  const allowHighRiskLots = !!planningHints?.allowHighRiskLots;

  const riskFlags = [];

  // Base sow multiplier from germination rate
  let sowRateMultiplier = 1.0;
  if (estimatedGerminationRate >= 85) {
    sowRateMultiplier = 1.0;
  } else if (estimatedGerminationRate >= 70) {
    sowRateMultiplier = 1.2;
  } else if (estimatedGerminationRate >= 50) {
    sowRateMultiplier = 1.5;
  } else if (estimatedGerminationRate > 0) {
    sowRateMultiplier = 2.0;
    riskFlags.push("very-low-germination");
  } else {
    sowRateMultiplier = 2.0;
    riskFlags.push("no-germination");
  }

  // Recommended status from viability
  let recommendedStatus = "ok";

  if (isStaple) {
    const adjustedThreshold = minimumViabilityForStaples * staplePriorityFactor;
    if (viabilityScore < adjustedThreshold) {
      riskFlags.push("staple-below-threshold");
    }
  }

  if (viabilityScore >= 80) {
    recommendedStatus = "ok";
  } else if (viabilityScore >= 65) {
    recommendedStatus = "watch";
  } else if (viabilityScore >= 40) {
    recommendedStatus = "replace-soon";
  } else {
    recommendedStatus = "replace-now";
  }

  if (recommendedStatus === "replace-now" && allowHighRiskLots) {
    riskFlags.push("allowed-high-risk");
  }

  return {
    sowRateMultiplier: roundTo(sowRateMultiplier, 2),
    recommendedStatus,
    riskFlags
  };
}

/**
 * Build user-facing notes for a given lot.
 */
function buildNotesForLot(ctx) {
  const notes = [];

  notes.push(
    `Estimated germination: ~${Math.round(
      ctx.estimatedGerminationRate
    )}% (viability score ${Math.round(ctx.viabilityScore)}).`
  );
  notes.push(
    `Suggested sow rate multiplier: ×${ctx.sowRateMultiplier.toFixed(2)}.`
  );

  if (ctx.recommendedStatus === "replace-now") {
    notes.push(
      "This lot is very low viability. Plan to replace or treat as an experiment only."
    );
  } else if (ctx.recommendedStatus === "replace-soon") {
    notes.push(
      "This lot is aging out. Over-sow heavily and plan to replace before the next main season."
    );
  } else if (ctx.recommendedStatus === "watch") {
    notes.push(
      "Borderline viability. Over-sow slightly and watch germination closely this season."
    );
  } else {
    notes.push("Viability looks good for the upcoming season.");
  }

  if (ctx.germinationTest && ctx.germinationTest.performed) {
    notes.push("Germination test data was used to refine this estimate.");
  } else {
    notes.push(
      "No recent germination test found. Consider running a quick test for key crops."
    );
  }

  return notes;
}

/**
 * Build Next Best Actions for a lot.
 */
function buildNextActionsForLot({ recommendedStatus, planning }) {
  const actions = [];

  if (recommendedStatus === "replace-now") {
    actions.push(
      "Mark this lot for replacement and check seed catalogs or local swaps."
    );
  } else if (recommendedStatus === "replace-soon") {
    actions.push(
      "Plan to replace this lot after this season, especially if it is important to household goals."
    );
  } else if (recommendedStatus === "watch") {
    actions.push(
      "Monitor germination closely and log actual results to refine future estimates."
    );
  }

  if (!planning || !Array.isArray(planning.targetBeds) || !planning.targetBeds.length) {
    actions.push(
      "Assign this lot to specific beds or blocks in the garden planner so sowing rates can be auto-calculated."
    );
  }

  actions.push(
    "Optionally schedule a germination test session if this crop is a staple or critical for storehouse goals."
  );

  return actions;
}

/**
 * Summarize results for the meta block.
 */
function buildSummary(results) {
  let highRiskLotCount = 0;
  let replaceNowCount = 0;

  for (const r of results) {
    if (r.viabilityScore < 50) highRiskLotCount += 1;
    if (r.recommendedStatus === "replace-now") replaceNowCount += 1;
  }

  return { highRiskLotCount, replaceNowCount };
}

/**
 * Optional Hub export for familyFundMode.
 *
 * @param {string} ts
 * @param {SeedViabilityResult} result
 * @param {any} planningHints
 */
async function tryExportToHub(ts, result, planningHints) {
  const packet = HubPacketFormatter.format({
    type: "seed.viability.summary",
    ts,
    source: SHIM_SOURCE,
    payload: {
      meta: result.meta,
      // Trimmed lot data for Hub
      lots: result.lots.map((lot) => ({
        id: lot.id,
        crop: lot.crop,
        viabilityScore: lot.viabilityScore,
        recommendedStatus: lot.recommendedStatus
      })),
      planningHints
    }
  });

  await FamilyFundConnector.send(packet);

  emit({
    type: "session.exported",
    ts: new Date().toISOString(),
    source: SHIM_SOURCE,
    data: {
      mode: "planningGraph",
      nodeKey: "seedViabilityCalculator",
      status: "ok"
    }
  });
}

/**
 * Utility: clamp numerical value.
 */
function clamp(num, min, max) {
  if (typeof num !== "number" || Number.isNaN(num)) return min;
  return Math.min(Math.max(num, min), max);
}

/**
 * Utility: round to decimal places.
 */
function roundTo(num, places) {
  const p = Math.pow(10, places);
  return Math.round(num * p) / p;
}

/**
 * Utility: create a small, safe summary of the payload for logging.
 */
function summarizePayload(payload) {
  if (!payload || typeof payload !== "object") return { kind: typeof payload };
  const count = Array.isArray(payload.seedLots) ? payload.seedLots.length : 0;
  return {
    kind: "SeedViabilityPayload",
    lotCount: count
  };
}
