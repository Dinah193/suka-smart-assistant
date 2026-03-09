/* eslint-disable no-console */
/**
 * PreservationTimeCalculator.shim.js
 *
 * Shim module for the Preservation Time Calculator in SSA.
 *
 * HOW THIS FITS:
 * - Pure logic + event emission; no React, no DOM.
 * - Called by SSA calculators/engines to estimate processing + storage times
 *   for canning/dehydration/curing/etc.
 * - Returns a payload that matches PreservationTimeCalculator.schema.json:
 *   {
 *     calculatorId,
 *     input,
 *     output: {
 *       recommendedProcessingTimeMinutes,
 *       recommendedStorageTimeDays,
 *       recommendedStorageTimeLabel,
 *       riskBand,
 *       warnings: string[],
 *       notes,
 *       sessionTemplateOverride?
 *     },
 *     meta: { version, computedAt, source }
 *   }
 * - Emits events via eventBus so SessionRunner / analytics can listen.
 * - Optionally exports results to the Hub when familyFundMode is true.
 *
 * IMPORTANT SAFETY NOTE:
 * - This calculator is an ESTIMATOR and DOES NOT replace tested, official
 *   preservation guidelines (e.g., USDA, trusted extension services).
 * - Always base real-world processing times on tested recipes for the exact
 *   food type, method, jar size, and altitude.
 */

import { emit } from "@/services/events/eventBus";
import { familyFundMode } from "@/config/featureFlags";
import { HubPacketFormatter, FamilyFundConnector } from "@/services/hub";

/**
 * @typedef {import("./PreservationTimeCalculator.schema.json")} PreservationTimeCalculatorSchema
 * (Type hint: VS Code will pick up the JSON schema if configured. This is
 * only a loose JSDoc reference and does not affect runtime.)
 */

const SHIM_ID = "preservationTimeCalculator";
const SHIM_VERSION = "1.0.0";

/**
 * Safely emit an event on the shared event bus.
 * @param {string} type
 * @param {any} data
 */
function emitEvent(type, data) {
  try {
    emit({
      type,
      ts: new Date().toISOString(),
      source: `calculators/${SHIM_ID}`,
      data,
    });
  } catch (err) {
    // Never crash caller because of event issues.
    console.warn(`[${SHIM_ID}] Failed to emit event`, type, err);
  }
}

/**
 * Export to Hub (if enabled) using the shared helpers.
 * @param {string} envelopeType
 * @param {object} payload
 * @returns {Promise<void>}
 */
async function exportToHubIfEnabled(envelopeType, payload) {
  if (!familyFundMode) return;
  try {
    const envelope = HubPacketFormatter.format({
      type: envelopeType,
      source: SHIM_ID,
      createdAt: new Date().toISOString(),
      payload,
    });
    await FamilyFundConnector.send(envelope);
    emitEvent("session.exported", {
      envelopeType,
      id: payload?.calculatorId || SHIM_ID,
    });
  } catch (err) {
    // Fail silently for Hub; log in console only.
    console.warn(`[${SHIM_ID}] Hub export failed`, err);
  }
}

/**
 * Normalize falsy / invalid numbers to null.
 * @param {any} value
 * @returns {number|null}
 */
function safeNumber(value) {
  if (typeof value !== "number" || Number.isNaN(value)) return null;
  return value;
}

/**
 * Derive a base processing time (minutes) from method + rough food type.
 * This is intentionally conservative and generic.
 *
 * REAL-WORLD USE:
 * - Treat this as a planning heuristic only.
 * - Real processing times must come from tested recipes.
 *
 * @param {string} method
 * @param {string} foodType
 * @returns {{ minutes: number, warnings: string[] }}
 */
function getBaseProcessingMinutes(method, foodType) {
  const warnings = [];
  const ft = (foodType || "").toLowerCase();

  // Broad categories
  const isLowAcid =
    ft.includes("meat") ||
    ft.includes("broth") ||
    ft.includes("stock") ||
    ft.includes("beans") ||
    ft.includes("peas") ||
    ft.includes("corn") ||
    ft.includes("greens");

  const isHighAcid =
    ft.includes("pickle") ||
    ft.includes("vinegar") ||
    ft.includes("tomato") ||
    ft.includes("jam") ||
    ft.includes("jelly") ||
    ft.includes("fruit");

  let minutes;

  switch (method) {
    case "pressureCanning":
      // Very rough: 75–90 min for low-acid pints, slightly lower for others
      if (isLowAcid) {
        minutes = 90;
        warnings.push(
          "Low-acid foods must be pressure canned using a tested recipe for the exact jar size and altitude."
        );
      } else {
        minutes = 60;
        warnings.push(
          "Pressure canning time is approximate; always use a tested recipe for your food and jar size."
        );
      }
      break;

    case "waterBathCanning":
      if (isLowAcid) {
        minutes = 0;
        warnings.push(
          "Water bath canning is NOT recommended for low-acid foods; use pressure canning with a tested recipe instead."
        );
      } else if (isHighAcid) {
        minutes = 20;
        warnings.push(
          "Water bath time is a rough planning value; always follow a tested recipe for your product and jar size."
        );
      } else {
        minutes = 25;
        warnings.push(
          "Food acidity is unclear; water bath times here are only for planning. Confirm with tested guidance."
        );
      }
      break;

    case "dehydration":
      // 6–12 hours typical; we express in minutes.
      minutes = 8 * 60;
      warnings.push(
        "Dehydration time varies widely by slice thickness, airflow, and humidity; monitor until food is fully dry."
      );
      break;

    case "curing":
      // 3–7 days baseline (express as minutes for consistency).
      minutes = 5 * 24 * 60;
      warnings.push(
        "Curing times are very approximate and depend on cut size, salt content, and temperature."
      );
      break;

    case "fermentation":
      // 3–14 days; we choose a middle value.
      minutes = 7 * 24 * 60;
      warnings.push(
        "Fermentation time depends on temperature, salt concentration, and taste preference; check regularly."
      );
      break;

    case "freezing":
      // No true "processing" time; we use a tiny placeholder.
      minutes = 10;
      warnings.push(
        "Freezing requires rapid chilling to safe temperatures; ensure foods cool to fridge temps before deep-freezing."
      );
      break;

    case "refrigeration":
      minutes = 0;
      warnings.push(
        "Refrigeration is storage only; ensure food is cooled quickly and kept below 40°F / 4°C."
      );
      break;

    default:
      minutes = 0;
      warnings.push(
        `Unknown preservation method '${method}'; processing time set to 0 minutes for planning.`
      );
      break;
  }

  return { minutes, warnings };
}

/**
 * Adjust processing minutes for volume and altitude.
 *
 * @param {number} baseMinutes
 * @param {number|null} volume
 * @param {string|undefined} volumeUnit
 * @param {number|null} altitudeMeters
 * @param {string} method
 * @returns {{ minutes: number, warnings: string[] }}
 */
function adjustProcessingForVolumeAndAltitude(
  baseMinutes,
  volume,
  volumeUnit,
  altitudeMeters,
  method
) {
  let minutes = baseMinutes;
  const warnings = [];

  const vol = safeNumber(volume);
  const alt = safeNumber(altitudeMeters);

  // Simple jar-size heuristic (for canning-like methods).
  if (vol !== null && vol > 0) {
    const unit = (volumeUnit || "").toLowerCase();
    let quartEquivalent = vol;

    switch (unit) {
      case "ml":
        quartEquivalent = vol / 946;
        break;
      case "liter":
        quartEquivalent = (vol * 1000) / 946;
        break;
      case "pint":
        quartEquivalent = vol / 2;
        break;
      case "cup":
        quartEquivalent = vol / 4;
        break;
      case "gallon":
        quartEquivalent = vol * 4;
        break;
      case "quart":
      default:
        quartEquivalent = vol;
        break;
    }

    if (quartEquivalent > 1.1) {
      // For containers larger than ~1 quart, bump by 10–20%.
      const factor = Math.min(1.3, 1 + (quartEquivalent - 1) * 0.1);
      minutes *= factor;
      warnings.push(
        "Container is larger than a quart; processing time increased as a conservative planning adjustment."
      );
    }
  }

  // Altitude adjustment: increase time for boiling-based methods.
  if (alt !== null && alt > 300) {
    let factor = 1.1; // default 10% increase

    if (alt > 900) factor = 1.2;
    if (alt > 1500) factor = 1.3;

    if (
      method === "pressureCanning" ||
      method === "waterBathCanning" ||
      method === "dehydration"
    ) {
      minutes *= factor;
      warnings.push(
        "Altitude is above 300m; processing time increased. Always confirm with altitude-adjusted tested guidance."
      );
    }
  }

  return { minutes: Math.round(minutes), warnings };
}

/**
 * Estimate storage time (days) and a human label based on method, temp,
 * humidity, and risk tolerance.
 *
 * This is a rough heuristic used for planning, NOT a hard safety guarantee.
 *
 * @param {string} method
 * @param {number|null} ambientTempC
 * @param {number|null} ambientHumidityPercent
 * @param {"veryLow"|"low"|"moderate"|"high"|string|undefined} riskTolerance
 * @returns {{ days: number, label: string, riskBand: "veryLow"|"low"|"moderate"|"high", warnings: string[] }}
 */
function estimateStorageTimeDays(
  method,
  ambientTempC,
  ambientHumidityPercent,
  riskTolerance
) {
  const warnings = [];
  const rt = riskTolerance || "low";
  const temp = ambientTempC ?? 20;
  const humidity = ambientHumidityPercent ?? 50;

  let baseDays;
  let riskBand;

  switch (method) {
    case "pressureCanning":
    case "waterBathCanning":
      baseDays = 365; // common planning target for shelf-stable canned goods.
      riskBand = rt === "veryLow" ? "veryLow" : "low";
      warnings.push(
        "Storage time assumes seals remain intact and jars are stored in a cool, dark place."
      );
      break;

    case "dehydration":
      baseDays = 180; // 6 months typical
      riskBand = "moderate";
      warnings.push(
        "Dehydrated foods must be fully dry and stored airtight; fat content can shorten shelf life."
      );
      break;

    case "curing":
    case "fermentation":
      baseDays = 90; // 3 months baseline
      riskBand = "moderate";
      warnings.push(
        "Cured and fermented foods have variable storage life; monitor for off smells, mold, or texture changes."
      );
      break;

    case "freezing":
      baseDays = 365; // up to a year for many foods
      riskBand = "low";
      warnings.push(
        "Freezer temperatures must remain at or below 0°F / -18°C for best quality."
      );
      break;

    case "refrigeration":
      baseDays = 7; // generic, very conservative
      riskBand = "high";
      warnings.push(
        "Refrigerated storage is short term. Discard if there are off odors, colors, or textures."
      );
      break;

    default:
      baseDays = 0;
      riskBand = "high";
      warnings.push(
        `Unknown preservation method '${method}'; storage time set to 0 days for planning until clarified.`
      );
      break;
  }

  // Adjust storage time based on temperature (warmer storage => shorter time).
  if (temp > 24) {
    baseDays *= 0.7;
    warnings.push(
      "Ambient temperature is relatively warm; recommended storage time reduced."
    );
  } else if (temp < 10) {
    baseDays *= 1.1;
    warnings.push(
      "Ambient temperature is cool; recommended storage time slightly increased for planning."
    );
  }

  // High humidity is bad for most shelf-stable / dehydrated foods.
  if (
    humidity > 70 &&
    (method === "dehydration" ||
      method === "curing" ||
      method === "fermentation")
  ) {
    baseDays *= 0.8;
    warnings.push(
      "Ambient humidity is high; recommended storage time reduced for dehydrated/fermented/ cured foods."
    );
  }

  // Adjust based on risk tolerance (more conservative => shorter time).
  switch (rt) {
    case "veryLow":
      baseDays *= 0.6;
      riskBand = "veryLow";
      warnings.push(
        "Household risk tolerance is set to VERY LOW; storage time reduced."
      );
      break;
    case "low":
      baseDays *= 0.8;
      riskBand = riskBand === "high" ? "moderate" : "low";
      warnings.push(
        "Household risk tolerance is set to LOW; storage time slightly reduced."
      );
      break;
    case "moderate":
      // no change
      riskBand = riskBand === "veryLow" ? "low" : riskBand;
      break;
    case "high":
      baseDays *= 1.2;
      riskBand = "high";
      warnings.push(
        "Household risk tolerance is HIGH; storage time increased. Always inspect food carefully before use."
      );
      break;
    default:
      break;
  }

  const daysRounded = Math.max(0, Math.round(baseDays));

  let label;
  if (daysRounded === 0) label = "use immediately / do not store";
  else if (daysRounded <= 7) label = "up to 1 week";
  else if (daysRounded <= 31) label = "up to 1 month";
  else if (daysRounded <= 93) label = "about 3 months";
  else if (daysRounded <= 186) label = "3–6 months";
  else if (daysRounded <= 365) label = "up to 1 year";
  else label = "up to 1–2 years (quality may decline)";

  return { days: daysRounded, label, riskBand, warnings };
}

/**
 * Build a simple default session template override that the SessionRunner
 * could use to drive a preservation session.
 *
 * @param {string} method
 * @param {number} processingMinutes
 * @returns {object}
 */
function buildSessionTemplateOverride(method, processingMinutes) {
  const prettyMethod = method || "preservation";

  return {
    title: `Run ${prettyMethod} session`,
    steps: [
      {
        id: "prep-jars-and-equipment",
        title: "Prep jars, containers, and equipment",
        desc: "Wash, inspect, and preheat jars or containers. Prepare lids, rings, gauges, and other equipment according to trusted guidelines.",
        durationSec: 15 * 60,
        blockers: ["inventory", "equipment"],
        metadata: {
          tempTargetF: 0,
          donenessCue: "timer",
          cueNotes: "Ensure all tools are clean and laid out before you begin.",
        },
      },
      {
        id: "process-items",
        title: "Process jars/containers",
        desc: `Load food into jars or containers, then process using your tested recipe for approximately ${processingMinutes} minutes. Use this time only as a planning estimate.`,
        durationSec: Math.max(0, processingMinutes * 60),
        blockers: ["inventory", "equipment", "quietHours"],
        metadata: {
          tempTargetF: 0,
          donenessCue: "timer",
          cueNotes:
            "Follow a tested preservation recipe for exact times, pressures, and temperatures.",
        },
      },
      {
        id: "cool-and-store",
        title: "Cool and store safely",
        desc: "Allow items to cool undisturbed. Check seals (if applicable), label with date and contents, and move to appropriate storage (shelf, fridge, freezer).",
        durationSec: 30 * 60,
        blockers: ["inventory"],
        metadata: {
          tempTargetF: 0,
          donenessCue: "timer",
          cueNotes:
            "Do not stack hot jars; allow airflow and avoid rapid temperature shocks.",
        },
      },
    ],
  };
}

/**
 * MAIN SHIM ENTRYPOINT
 *
 * @param {object} params
 * @param {object} params.input - Must match `input` object defined in the schema.
 * @param {string} [params.source] - Optional origin of the call (e.g. 'ui', 'automation', 'session').
 * @returns {Promise<object>} - Calculator result matching PreservationTimeCalculator.schema.json.
 */
export async function runPreservationTimeCalculator({ input, source = "ui" }) {
  const startedAt = new Date().toISOString();

  emitEvent("calculator.run.started", {
    calculatorId: SHIM_ID,
    source,
    input,
  });

  // Defensive checks
  if (!input || typeof input !== "object") {
    const errorPayload = {
      calculatorId: SHIM_ID,
      error: "Invalid input; expected an object matching the schema.",
      source,
    };
    emitEvent("calculator.run.failed", errorPayload);
    return {
      calculatorId: SHIM_ID,
      input: input || null,
      output: {
        recommendedProcessingTimeMinutes: 0,
        recommendedStorageTimeDays: 0,
        recommendedStorageTimeLabel: "use immediately / do not store",
        riskBand: "high",
        warnings: ["Invalid input provided to preservation time calculator."],
        notes: "No calculation was performed due to invalid input.",
      },
      meta: {
        version: SHIM_VERSION,
        computedAt: startedAt,
        source,
      },
    };
  }

  const {
    foodType,
    preservationMethod,
    containerVolume,
    containerVolumeUnit,
    altitudeMeters,
    ambientTemperatureC,
    ambientHumidityPercent,
    householdRiskTolerance,
  } = input;

  const method = preservationMethod || "other";

  // 1. Base processing minutes based on method and food type
  const baseProc = getBaseProcessingMinutes(method, foodType);
  const adjustedProc = adjustProcessingForVolumeAndAltitude(
    baseProc.minutes,
    containerVolume,
    containerVolumeUnit,
    altitudeMeters,
    method
  );

  const totalProcessingMinutes = adjustedProc.minutes;
  const processingWarnings = [...baseProc.warnings, ...adjustedProc.warnings];

  // 2. Estimate storage time (days, label, risk band)
  const storageEst = estimateStorageTimeDays(
    method,
    safeNumber(ambientTemperatureC),
    safeNumber(ambientHumidityPercent),
    householdRiskTolerance
  );

  // 3. Combine warnings and notes
  const warnings = [...processingWarnings, ...storageEst.warnings];
  warnings.push(
    "Always follow tested preservation recipes from trusted sources for exact times, pressures, and temperatures."
  );

  const sessionTemplateOverride = buildSessionTemplateOverride(
    method,
    totalProcessingMinutes
  );

  const output = {
    recommendedProcessingTimeMinutes: totalProcessingMinutes,
    recommendedStorageTimeDays: storageEst.days,
    recommendedStorageTimeLabel: storageEst.label,
    riskBand: storageEst.riskBand,
    warnings,
    notes:
      "Values are for household planning only and are not a substitute for tested, official preservation guidelines.",
    sessionTemplateOverride,
  };

  const result = {
    calculatorId: SHIM_ID,
    input,
    output,
    meta: {
      version: SHIM_VERSION,
      computedAt: new Date().toISOString(),
      source,
    },
  };

  emitEvent("calculator.run.completed", {
    calculatorId: SHIM_ID,
    source,
    outputSummary: {
      recommendedProcessingTimeMinutes: output.recommendedProcessingTimeMinutes,
      recommendedStorageTimeDays: output.recommendedStorageTimeDays,
      riskBand: output.riskBand,
    },
  });

  // Optional Hub export (non-blocking)
  exportToHubIfEnabled("calculator.result.preservationTime", result).catch(
    () => {}
  );

  return result;
}

/**
 * Default export for convenience if you want a more generic shim handle.
 */
const PreservationTimeCalculatorShim = {
  id: SHIM_ID,
  version: SHIM_VERSION,
  run: runPreservationTimeCalculator,
};

export default PreservationTimeCalculatorShim;
