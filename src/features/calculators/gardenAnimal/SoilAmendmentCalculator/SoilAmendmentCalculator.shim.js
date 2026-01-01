// C:\Users\larho\suka-smart-assistant\src\features\calculators\gardenAnimal\SoilAmendmentCalculator\SoilAmendmentCalculator.shim.js

/**
 * SoilAmendmentCalculator shim
 *
 * HOW THIS FITS:
 * - Takes a SoilAmendmentCalculator payload (see SoilAmendmentCalculator.schema.json).
 * - Computes per-bed soil amendment recommendations based on soil tests, texture,
 *   and target fertility ranges.
 * - Produces:
 *    - outputs.amendmentPlan: list of amendment rows (material, rate, total).
 *    - outputs.amendmentSessions: “prep soil” garden sessions (lightweight) for each bed.
 *    - outputs.amendmentSummary: aggregate stats for UI and Planning Graph flows.
 * - Emits calculator events on the SSA event bus (if provided).
 *
 * NOTE:
 * - This shim is pure logic + light orchestration; it does NOT open UI or sessions.
 * - SessionRunner will later consume amendmentSessions (or turn them into full Session
 *   objects) via hooks or planners.
 */

/**
 * @typedef {Object} SoilBed
 * @property {string} bedId
 * @property {string} [name]
 * @property {number} [areaSqFt]
 * @property {number} [depthInches]
 */

/**
 * @typedef {Object} SoilTest
 * @property {string} testId
 * @property {string} bedId
 * @property {string} [takenAt]
 * @property {number} [ph]
 * @property {number} [nPpm]
 * @property {number} [pPpm]
 * @property {number} [kPpm]
 * @property {number} [caPpm]
 * @property {number} [mgPpm]
 * @property {string} [recommendationNotes]
 */

/**
 * @typedef {Object} TargetFertility
 * @property {number} [phMin]
 * @property {number} [phMax]
 * @property {number} [nMin]
 * @property {number} [nMax]
 * @property {number} [pMin]
 * @property {number} [pMax]
 * @property {number} [kMin]
 * @property {number} [kMax]
 */

/**
 * @typedef {Object} ShimEnv
 * @property {{ emit?: (evt: {type:string, ts:string, source:string, data:any}) => void }} [eventBus]
 * @property {{ familyFundMode?: boolean }} [featureFlags]
 * @property {{ exportToHubIfEnabled?: (payload:any) => Promise<void> }} [hub]
 */

/**
 * Run the SoilAmendmentCalculator shim.
 *
 * @param {any} rawPayload - Input payload, loosely validated and normalized here.
 * @param {ShimEnv} [env] - Optional environment (eventBus, featureFlags, hub).
 * @returns {Promise<any>} - Normalized payload with outputs populated.
 */
export async function runSoilAmendmentCalculatorShim(rawPayload, env = {}) {
  const tsStart = new Date().toISOString();
  const { eventBus, featureFlags, hub } = env;

  const contextNodeKey =
    rawPayload && rawPayload.context && rawPayload.context.nodeKey
      ? String(rawPayload.context.nodeKey)
      : "garden.soilAmendment";

  emitSafe(eventBus, {
    type: "calculator.run.started",
    ts: tsStart,
    source: "calculators/gardenAnimal/SoilAmendmentCalculator.shim",
    data: {
      nodeKey: contextNodeKey,
      kind: "SoilAmendmentCalculator",
      rawPayloadPreview: previewPayload(rawPayload)
    }
  });

  const payload = normalizePayload(rawPayload);

  const inputs = payload.inputs || {};
  const soilProfile = inputs.soilProfile || {};
  const soilTests = safeArray(inputs.soilTests);
  const targetFertility = deriveTargetFertilityDefaults(inputs.targetFertility);
  const gardenLayout = inputs.gardenLayout || {};
  const layoutBeds = safeArray(gardenLayout.beds);

  const logicalBeds = deriveLogicalBeds(soilProfile, layoutBeds);
  const amendmentPlan = [];
  const amendmentSessions = [];

  for (const bed of logicalBeds) {
    const bedId = String(bed.bedId);
    const bedArea = toNumber(bed.areaSqFt, 100); // default area if unknown
    const bedDepth = toNumber(bed.depthInches, 8); // default 8" working depth

    const bedTest = pickLatestTestForBed(soilTests, bedId);
    const bedTexture = (bed.texture || soilProfile.defaultTexture || "unknown");

    const bedAmendments = computeAmendmentsForBed({
      bed,
      bedArea,
      bedDepth,
      bedTexture,
      bedTest,
      targetFertility
    });

    for (const row of bedAmendments) {
      amendmentPlan.push(row);
    }

    if (bedAmendments.length > 0) {
      const bedSession = buildAmendmentSessionForBed(bed, bedAmendments);
      amendmentSessions.push(bedSession);
    }
  }

  const amendmentSummary = buildSummary(amendmentPlan, amendmentSessions, logicalBeds);

  const outputs = {
    amendmentPlan,
    amendmentSessions,
    amendmentSummary
  };

  const finalPayload = {
    ...payload,
    outputs
  };

  const tsEnd = new Date().toISOString();

  emitSafe(eventBus, {
    type: "calculator.run.completed",
    ts: tsEnd,
    source: "calculators/gardenAnimal/SoilAmendmentCalculator.shim",
    data: {
      nodeKey: contextNodeKey,
      kind: "SoilAmendmentCalculator",
      stats: {
        totalBeds: amendmentSummary.totalBeds,
        totalMaterials: amendmentSummary.totalMaterials,
        totalSessions: amendmentSummary.totalSessions
      }
    }
  });

  // Optional: export to Hub as a planning node if familyFundMode is enabled
  if (featureFlags && featureFlags.familyFundMode && hub && typeof hub.exportToHubIfEnabled === "function") {
    try {
      await hub.exportToHubIfEnabled({
        type: "planning.soilAmendment",
        ts: tsEnd,
        nodeKey: contextNodeKey,
        payload: finalPayload
      });
      emitSafe(eventBus, {
        type: "calculator.run.exported",
        ts: new Date().toISOString(),
        source: "calculators/gardenAnimal/SoilAmendmentCalculator.shim",
        data: {
          nodeKey: contextNodeKey,
          kind: "SoilAmendmentCalculator"
        }
      });
    } catch (err) {
      // Fail silently per spec
      // eslint-disable-next-line no-console
      console.warn("[SoilAmendmentCalculator.shim] Hub export failed:", err);
    }
  }

  return finalPayload;
}

// ---------------------------------------------------------------------------
// Normalization & helpers
// ---------------------------------------------------------------------------

function normalizePayload(raw) {
  const now = new Date();
  const base = {
    context: {
      nodeKey: "garden.soilAmendment",
      version: "1.0.0",
      runId: `soilAmend-${now.getTime()}`
    },
    inputs: {
      soilProfile: {
        defaultTexture: "unknown",
        beds: []
      },
      soilTests: [],
      targetFertility: {},
      plantingPlan: [],
      gardenLayout: {
        beds: []
      },
      householdProfile: {}
    },
    outputs: null
  };

  if (!raw || typeof raw !== "object") return base;

  return {
    ...base,
    ...raw,
    context: {
      ...base.context,
      ...(raw.context || {})
    },
    inputs: {
      ...base.inputs,
      ...(raw.inputs || {}),
      soilProfile: {
        ...base.inputs.soilProfile,
        ...((raw.inputs && raw.inputs.soilProfile) || {}),
        beds: safeArray(raw.inputs && raw.inputs.soilProfile && raw.inputs.soilProfile.beds)
      },
      soilTests: safeArray(raw.inputs && raw.inputs.soilTests),
      plantingPlan: safeArray(raw.inputs && raw.inputs.plantingPlan),
      gardenLayout: {
        ...base.inputs.gardenLayout,
        ...((raw.inputs && raw.inputs.gardenLayout) || {}),
        beds: safeArray(raw.inputs && raw.inputs.gardenLayout && raw.inputs.gardenLayout.beds)
      }
    }
  };
}

/**
 * Ensure a value is always an array.
 * @param {any} v
 * @returns {any[]}
 */
function safeArray(v) {
  return Array.isArray(v) ? v : [];
}

/**
 * Convert to number with fallback.
 * @param {any} v
 * @param {number} fallback
 * @returns {number}
 */
function toNumber(v, fallback) {
  if (v === null || v === undefined || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Emits events safely (no-ops on missing eventBus).
 * @param {ShimEnv["eventBus"]} eventBus
 * @param {{type:string, ts:string, source:string, data:any}} evt
 */
function emitSafe(eventBus, evt) {
  if (!eventBus || typeof eventBus.emit !== "function") return;
  try {
    eventBus.emit(evt);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[SoilAmendmentCalculator.shim] eventBus.emit failed:", err);
  }
}

/**
 * Return a tiny preview for logs only.
 * @param {any} raw
 */
function previewPayload(raw) {
  if (!raw || typeof raw !== "object") return null;
  const context = raw.context || {};
  const inputs = raw.inputs || {};
  return {
    nodeKey: context.nodeKey,
    version: context.version,
    beds: safeArray(inputs.gardenLayout && inputs.gardenLayout.beds).length,
    tests: safeArray(inputs.soilTests).length
  };
}

/**
 * Derive target fertility with reasonable defaults if not fully specified.
 * @param {any} rawTarget
 * @returns {TargetFertility}
 */
function deriveTargetFertilityDefaults(rawTarget) {
  const base = {
    phMin: 6.2,
    phMax: 7.0,
    nMin: 40,
    nMax: 80,
    pMin: 25,
    pMax: 50,
    kMin: 75,
    kMax: 150
  };
  if (!rawTarget || typeof rawTarget !== "object") return base;
  return {
    ...base,
    ...rawTarget
  };
}

/**
 * Build a unified list of beds from soilProfile + gardenLayout.
 * Prefers gardenLayout.beds for area/depth, merges soilProfile.beds by bedId.
 * @param {any} soilProfile
 * @param {SoilBed[]} layoutBeds
 * @returns {Array<SoilBed & {texture?:string, organicMatterPct?:number, drainage?:string}>}
 */
function deriveLogicalBeds(soilProfile, layoutBeds) {
  const profileBeds = safeArray(soilProfile.beds);
  const byId = new Map();

  for (const b of layoutBeds) {
    if (!b || !b.bedId) continue;
    byId.set(String(b.bedId), { ...b });
  }

  for (const pb of profileBeds) {
    if (!pb || !pb.bedId) continue;
    const id = String(pb.bedId);
    const existing = byId.get(id) || { bedId: id };
    byId.set(id, {
      ...existing,
      ...pb
    });
  }

  return Array.from(byId.values());
}

/**
 * Pick the latest soil test record for a given bed.
 * @param {SoilTest[]} tests
 * @param {string} bedId
 * @returns {SoilTest | null}
 */
function pickLatestTestForBed(tests, bedId) {
  const bedTests = tests.filter((t) => t && String(t.bedId) === String(bedId));
  if (bedTests.length === 0) return null;
  bedTests.sort((a, b) => {
    const da = a.takenAt ? Date.parse(a.takenAt) : 0;
    const db = b.takenAt ? Date.parse(b.takenAt) : 0;
    return db - da;
  });
  return bedTests[0];
}

/**
 * Compute amendments for a single bed using simple rule-of-thumb logic.
 *
 * This is intentionally conservative and explainable:
 * - If pH < phMin => add agricultural lime.
 * - If pH > phMax => add sulfur / acidifying compost.
 * - If N, P, or K below target => add compost + organic fertilizer blend.
 *
 * @param {Object} opts
 * @param {any} opts.bed
 * @param {number} opts.bedArea
 * @param {number} opts.bedDepth
 * @param {string} opts.bedTexture
 * @param {SoilTest | null} opts.bedTest
 * @param {TargetFertility} opts.targetFertility
 * @returns {Array<any>}
 */
function computeAmendmentsForBed({
  bed,
  bedArea,
  bedDepth,
  bedTexture,
  bedTest,
  targetFertility
}) {
  const planRows = [];
  const bedId = String(bed.bedId);
  const nowTs = Date.now();

  const ph = bedTest && typeof bedTest.ph === "number" ? bedTest.ph : null;
  const n = bedTest && typeof bedTest.nPpm === "number" ? bedTest.nPpm : null;
  const p = bedTest && typeof bedTest.pPpm === "number" ? bedTest.pPpm : null;
  const k = bedTest && typeof bedTest.kPpm === "number" ? bedTest.kPpm : null;

  // 1) pH correction
  if (typeof ph === "number") {
    if (ph < targetFertility.phMin) {
      const severity = ph <= targetFertility.phMin - 1 ? "critical" : "high";
      // VERY rough: 0.1–0.2 lb of lime per sq ft depending on deficit
      const phDeficit = targetFertility.phMin - ph; // positive
      const ratePerSqFt = clampNumber(0.05 + phDeficit * 0.08, 0.05, 0.25);
      const totalAmount = roundTo(ratePerSqFt * bedArea, 2);

      planRows.push({
        planId: `amend-${bedId}-lime-${nowTs}`,
        bedId,
        materialId: "lime-agricultural",
        materialName: "Agricultural lime",
        ratePerSqFt,
        totalAmount,
        materialUnit: "lb",
        priority: severity,
        reason: `Soil pH is low (${ph.toFixed(
          1
        )}); raise toward ${targetFertility.phMin.toFixed(1)}–${targetFertility.phMax.toFixed(
          1
        )}.`
      });
    } else if (ph > targetFertility.phMax) {
      const severity = ph >= targetFertility.phMax + 1 ? "critical" : "high";
      // Very rough: 0.02–0.08 lb sulfur per sq ft depending on surplus
      const phSurplus = ph - targetFertility.phMax;
      const ratePerSqFt = clampNumber(0.02 + phSurplus * 0.04, 0.02, 0.08);
      const totalAmount = roundTo(ratePerSqFt * bedArea, 2);

      planRows.push({
        planId: `amend-${bedId}-sulfur-${nowTs}`,
        bedId,
        materialId: "sulfur-elemental",
        materialName: "Elemental sulfur / acidifying compost",
        ratePerSqFt,
        totalAmount,
        materialUnit: "lb",
        priority: severity,
        reason: `Soil pH is high (${ph.toFixed(
          1
        )}); gently lower toward ${targetFertility.phMin.toFixed(1)}–${targetFertility.phMax.toFixed(
          1
        )}.`
      });
    }
  }

  // 2) Organic matter & texture: base compost recommendation per sq ft
  const compostRatePerSqFt = deriveCompostRateForTexture(bedTexture, bedDepth);
  if (compostRatePerSqFt > 0) {
    const compostTotal = roundTo(compostRatePerSqFt * bedArea, 2);
    planRows.push({
      planId: `amend-${bedId}-compost-${nowTs}`,
      bedId,
      materialId: "compost-general",
      materialName: "Finished compost",
      ratePerSqFt: compostRatePerSqFt,
      totalAmount: compostTotal,
      materialUnit: "cu_ft",
      priority: "medium",
      reason: "Improve soil structure, water-holding, and biological activity."
    });
  }

  // 3) Nitrogen
  if (typeof n === "number" && typeof targetFertility.nMin === "number") {
    if (n < targetFertility.nMin) {
      const deficit = targetFertility.nMin - n;
      // Very rough: 0.05–0.15 lb N per 100 sq ft depending on deficit.
      const ratePer100SqFt = clampNumber(0.05 + deficit * 0.002, 0.05, 0.25);
      const ratePerSqFt = ratePer100SqFt / 100;
      const totalAmount = roundTo(ratePerSqFt * bedArea, 2);

      planRows.push({
        planId: `amend-${bedId}-N-${nowTs}`,
        bedId,
        materialId: "fertilizer-balanced-N",
        materialName: "Organic nitrogen source (blood meal, feather meal, etc.)",
        ratePerSqFt,
        totalAmount,
        materialUnit: "lb",
        priority: "high",
        reason: `Nitrogen is below target (N=${n.toFixed(0)}; target ≥ ${
          targetFertility.nMin
        }).`
      });
    }
  }

  // 4) Phosphorus
  if (typeof p === "number" && typeof targetFertility.pMin === "number") {
    if (p < targetFertility.pMin) {
      const deficit = targetFertility.pMin - p;
      const ratePer100SqFt = clampNumber(0.1 + deficit * 0.003, 0.1, 0.3);
      const ratePerSqFt = ratePer100SqFt / 100;
      const totalAmount = roundTo(ratePerSqFt * bedArea, 2);

      planRows.push({
        planId: `amend-${bedId}-P-${nowTs}`,
        bedId,
        materialId: "fertilizer-P",
        materialName: "Rock phosphate or bone meal",
        ratePerSqFt,
        totalAmount,
        materialUnit: "lb",
        priority: "medium",
        reason: `Phosphorus is below target (P=${p.toFixed(0)}; target ≥ ${
          targetFertility.pMin
        }).`
      });
    }
  }

  // 5) Potassium
  if (typeof k === "number" && typeof targetFertility.kMin === "number") {
    if (k < targetFertility.kMin) {
      const deficit = targetFertility.kMin - k;
      const ratePer100SqFt = clampNumber(0.1 + deficit * 0.0015, 0.1, 0.3);
      const ratePerSqFt = ratePer100SqFt / 100;
      const totalAmount = roundTo(ratePerSqFt * bedArea, 2);

      planRows.push({
        planId: `amend-${bedId}-K-${nowTs}`,
        bedId,
        materialId: "fertilizer-K",
        materialName: "Sulfate of potash / kelp meal",
        ratePerSqFt,
        totalAmount,
        materialUnit: "lb",
        priority: "medium",
        reason: `Potassium is below target (K=${k.toFixed(0)}; target ≥ ${
          targetFertility.kMin
        }).`
      });
    }
  }

  return planRows;
}

/**
 * Derive compost rate per sq ft based on texture and depth.
 *
 * Returns cubic feet per square foot.
 *
 * @param {string} texture
 * @param {number} depthInches
 */
function deriveCompostRateForTexture(texture, depthInches) {
  const depthFactor = clampNumber(depthInches / 6, 0.5, 2); // base at 6", scale between 0.5–2
  let base;

  switch (texture) {
    case "sand":
    case "sandy-loam":
      base = 0.15; // 0.15 cu ft / sq ft (~2" layer)
      break;
    case "clay":
    case "clay-loam":
      base = 0.12; // slightly thinner layer but still generous
      break;
    case "loam":
    case "silt-loam":
      base = 0.08; // maintenance dose
      break;
    default:
      base = 0.1;
      break;
  }

  return roundTo(base * depthFactor, 3);
}

/**
 * Build a lightweight amendment session descriptor for a given bed.
 *
 * NOTE: This is NOT a full Session object; hooks will later convert it
 * into the SSA Session contract for SessionRunner.
 *
 * @param {SoilBed & any} bed
 * @param {any[]} bedAmendments
 */
function buildAmendmentSessionForBed(bed, bedAmendments) {
  const bedId = String(bed.bedId);
  const title = `Prep & amend bed: ${bed.name || bedId}`;
  const perRowMinutes = 12; // simple heuristic
  const baseMinutes = 20;
  const estimatedMinutes = baseMinutes + perRowMinutes * bedAmendments.length;

  return {
    sessionId: `soil-amend-session-${bedId}-${Date.now()}`,
    bedId,
    title,
    plannedDate: null,
    estimatedDurationSec: Math.round(estimatedMinutes * 60)
  };
}

/**
 * Build a summary object for the outputs.
 * @param {any[]} amendmentPlan
 * @param {any[]} amendmentSessions
 * @param {any[]} logicalBeds
 */
function buildSummary(amendmentPlan, amendmentSessions, logicalBeds) {
  const bedIds = new Set();
  const materials = new Set();

  for (const row of amendmentPlan) {
    if (row && row.bedId) bedIds.add(String(row.bedId));
    if (row && row.materialName) materials.add(row.materialName);
  }

  let totalMinutes = 0;
  for (const s of amendmentSessions) {
    if (!s || typeof s.estimatedDurationSec !== "number") continue;
    totalMinutes += s.estimatedDurationSec / 60;
  }

  return {
    totalBeds: logicalBeds.length,
    totalMaterials: materials.size,
    totalSessions: amendmentSessions.length,
    estimatedTotalLaborMinutes: Math.round(totalMinutes),
    notes:
      logicalBeds.length === 0
        ? "No beds detected; add garden layout or soil profile to generate an amendment plan."
        : ""
  };
}

/**
 * Clamp a number between min and max.
 * @param {number} value
 * @param {number} min
 * @param {number} max
 */
function clampNumber(value, min, max) {
  if (!Number.isFinite(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/**
 * Round a number to a fixed number of decimals.
 * @param {number} value
 * @param {number} decimals
 */
function roundTo(value, decimals) {
  const pow = Math.pow(10, decimals);
  return Math.round(value * pow) / pow;
}
