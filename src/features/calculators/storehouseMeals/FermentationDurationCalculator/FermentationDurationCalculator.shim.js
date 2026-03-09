// C:\Users\larho\suka-smart-assistant\src\features\calculators\storehouseMeals\FermentationDurationCalculator\FermentationDurationCalculator.shim.js

/**
 * FermentationDurationCalculator.shim.js
 *
 * HOW THIS FITS:
 * - This is an SSA "shim" logic module for calculating fermentation durations
 *   and schedules for wine, beer, kraut, pickles, etc.
 * - It consumes a payload matching FermentationDurationCalculator.schema.json
 *   and produces `outputs` (schedule, ready window, storage shift, hints).
 * - It emits calculator.* events via the SSA eventBus and can optionally
 *   export results to the Hub when familyFundMode is enabled.
 *
 * This shim does NOT render UI or run sessions itself; instead it:
 *   1. Computes timing data.
 *   2. Emits "calculator.fermentationDuration.completed" or ".error".
 *   3. Provides `sessionSuggestions` that SessionRunner can materialize.
 */

import { emit as emitEvent } from "@/services/events/eventBus";
import { familyFundMode } from "@/config/featureFlags";
import { HubPacketFormatter, FamilyFundConnector } from "@/services/hub";

/**
 * @typedef {import("./FermentationDurationCalculator.schema.json")} FermentationDurationSchema
 */

/**
 * Main entrypoint: run the fermentation duration calculator.
 *
 * @param {Object} payload - Calculator invocation payload.
 * @param {FermentationDurationSchema} payload.data - Data matching the schema.
 * @param {Object} [options]
 * @param {boolean} [options.silent=false] - If true, do not emit events.
 * @returns {Promise<FermentationDurationSchema>} - Payload with populated outputs.
 */
export async function runFermentationDurationCalculator(payload, options = {}) {
  const { silent = false } = options;
  const ts = new Date().toISOString();
  const source = "calculators/FermentationDurationCalculator.shim";

  try {
    const normalized = normalizePayload(payload);
    const outputs = computeOutputs(normalized);
    const result = {
      ...payload,
      data: {
        ...payload.data,
        outputs,
      },
    };

    if (!silent) {
      emitEvent({
        type: "calculator.fermentationDuration.completed",
        ts,
        source,
        data: {
          inputs: normalized.inputs,
          outputs,
          meta: normalized.meta,
        },
      });

      await exportToHubIfEnabled({
        calculatorId: "FermentationDurationCalculator",
        inputs: normalized.inputs,
        outputs,
        meta: normalized.meta,
        ts,
      });
    }

    return result;
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));

    if (!silent) {
      emitEvent({
        type: "calculator.fermentationDuration.error",
        ts,
        source,
        data: {
          error: error.message,
          stack: error.stack || null,
          rawPayload: payload,
        },
      });
    }

    throw error;
  }
}

/**
 * Normalize and validate incoming payload.
 *
 * @param {Object} payload
 * @returns {{
 *   inputs: FermentationDurationSchema["properties"]["inputs"],
 *   meta: FermentationDurationSchema["properties"]["meta"]
 * }}
 */
function normalizePayload(payload) {
  if (!payload || typeof payload !== "object") {
    throw new Error(
      "FermentationDurationCalculator: payload must be an object."
    );
  }

  const data = payload.data || payload;
  const inputs = data.inputs || {};
  const product = inputs.product || {};
  const fermentation = inputs.fermentation || {};

  // Defensive required field checks
  if (!product.type || typeof product.type !== "string") {
    throw new Error(
      "FermentationDurationCalculator: inputs.product.type is required."
    );
  }
  if (typeof product.batchSize !== "number" || product.batchSize <= 0) {
    throw new Error(
      "FermentationDurationCalculator: inputs.product.batchSize must be a positive number."
    );
  }
  if (!product.unit || typeof product.unit !== "string") {
    throw new Error(
      "FermentationDurationCalculator: inputs.product.unit is required."
    );
  }
  if (!fermentation.method || typeof fermentation.method !== "string") {
    throw new Error(
      "FermentationDurationCalculator: inputs.fermentation.method is required."
    );
  }
  if (!fermentation.temperatureRange) {
    throw new Error(
      "FermentationDurationCalculator: inputs.fermentation.temperatureRange is required."
    );
  }
  if (
    !fermentation.targetStyle ||
    typeof fermentation.targetStyle !== "string"
  ) {
    throw new Error(
      "FermentationDurationCalculator: inputs.fermentation.targetStyle is required."
    );
  }

  const scheduleAnchor =
    inputs.scheduleAnchor && isValidDate(inputs.scheduleAnchor)
      ? new Date(inputs.scheduleAnchor)
      : new Date();

  const meta = {
    ...(data.meta || {}),
    calculatorId: "FermentationDurationCalculator",
    requestedAt:
      data.meta?.requestedAt && isValidDate(data.meta.requestedAt)
        ? data.meta.requestedAt
        : new Date().toISOString(),
  };

  return {
    inputs: {
      ...inputs,
      product,
      fermentation,
      scheduleAnchor,
      timezone: inputs.timezone || "America/Chicago",
    },
    meta,
  };
}

/**
 * Compute all outputs for the calculator given normalized inputs.
 *
 * @param {{ inputs: any, meta: any }} normalized
 */
function computeOutputs(normalized) {
  const { inputs } = normalized;
  const { product, fermentation, scheduleAnchor, timezone } = inputs;

  const avgTemp = getAverageTemperature(fermentation.temperatureRange);
  const activeFermentDays = estimateActiveFermentDays({
    productType: product.type,
    method: fermentation.method,
    targetStyle: fermentation.targetStyle,
    avgTemp,
  });

  const coldStorageDays = estimateColdStorageDays({
    method: fermentation.method,
    desiredShelfLifeDays: fermentation.desiredShelfLifeDays,
  });

  const anchor =
    scheduleAnchor instanceof Date ? scheduleAnchor : new Date(scheduleAnchor);

  // Phases
  const activeStart = anchor;
  const activeEnd = addDays(activeStart, activeFermentDays);
  const coldStart = activeEnd;
  const coldEnd = addDays(coldStart, coldStorageDays);

  const schedule = [
    {
      phaseId: "active_ferment",
      label: "Active Fermentation",
      durationDays: activeFermentDays,
      startAt: activeStart.toISOString(),
      endAt: activeEnd.toISOString(),
      checkpoints: buildActiveFermentCheckpoints(activeFermentDays),
    },
    {
      phaseId: "cold_storage",
      label: "Cold Storage / Maturation",
      durationDays: coldStorageDays,
      startAt: coldStart.toISOString(),
      endAt: coldEnd.toISOString(),
      checkpoints: [],
    },
  ];

  const targetReadyWindow = {
    start: addDays(activeEnd, 1).toISOString(),
    end: addDays(
      activeEnd,
      Math.max(7, Math.round(coldStorageDays / 3))
    ).toISOString(),
  };

  const storageShift = {
    moveAt: coldStart.toISOString(),
    targetStorage: pickDefaultStorageLocation(fermentation.method),
  };

  const sessionSuggestions = buildSessionSuggestions({
    product,
    fermentation,
    schedule,
    timezone,
  });

  const inventoryHints = buildInventoryHints({
    product,
    targetReadyWindow,
  });

  return {
    schedule,
    targetReadyWindow,
    storageShift,
    sessionSuggestions,
    inventoryHints,
  };
}

/**
 * Compute average temperature from the provided range.
 *
 * @param {{ unit: "C"|"F", min: number, max: number }} range
 * @returns {{ valueC: number, valueF: number }}
 */
function getAverageTemperature(range) {
  const unit = (range.unit || "F").toUpperCase();
  const min = typeof range.min === "number" ? range.min : range.max;
  const max = typeof range.max === "number" ? range.max : range.min;
  const mid = (min + max) / 2;

  if (unit === "C") {
    return {
      valueC: mid,
      valueF: (mid * 9) / 5 + 32,
    };
  }

  // Assume Fahrenheit
  const valueF = mid;
  const valueC = ((valueF - 32) * 5) / 9;
  return { valueC, valueF };
}

/**
 * Estimate the active fermentation duration in days using heuristics.
 *
 * @param {{ productType: string, method: string, targetStyle: string, avgTemp: { valueC: number, valueF: number } }} ctx
 * @returns {number}
 */
function estimateActiveFermentDays(ctx) {
  const productType = (ctx.productType || "").toLowerCase();
  const method = (ctx.method || "").toLowerCase();
  const style = (ctx.targetStyle || "").toLowerCase();
  const tempF = ctx.avgTemp?.valueF ?? 68;

  // Baseline at ~68°F
  let baseDays;

  if (productType.includes("cabbage") || productType.includes("kraut")) {
    baseDays = 7;
  } else if (
    productType.includes("cucumber") ||
    productType.includes("pickle")
  ) {
    baseDays = 5;
  } else if (productType.includes("pepper")) {
    baseDays = 6;
  } else if (productType.includes("wine")) {
    baseDays = 14;
  } else if (productType.includes("beer")) {
    baseDays = 7;
  } else {
    baseDays = 7;
  }

  // Method adjustments
  if (method === "starter_based") {
    baseDays -= 2;
  } else if (method === "wild") {
    baseDays += 2;
  }

  // Style adjustments
  if (style.includes("mild")) {
    baseDays -= 2;
  } else if (style.includes("tangy")) {
    // baseline
  } else if (style.includes("sour")) {
    baseDays += 2;
  }

  // Temperature adjustment: warmer = faster, cooler = slower.
  // For each 5°F above/below 68°F, adjust by ~1 day.
  const deltaF = tempF - 68;
  const tempAdjustment = -Math.round(deltaF / 5);

  let result = baseDays + tempAdjustment;
  if (result < 2) result = 2;
  if (result > 30) result = 30;

  return result;
}

/**
 * Estimate cold storage / maturation days.
 *
 * @param {{ method: string, desiredShelfLifeDays?: number }} ctx
 * @returns {number}
 */
function estimateColdStorageDays(ctx) {
  if (
    typeof ctx.desiredShelfLifeDays === "number" &&
    ctx.desiredShelfLifeDays > 0
  ) {
    return ctx.desiredShelfLifeDays;
  }

  const method = (ctx.method || "").toLowerCase();

  if (method === "wine") {
    return 180; // 6 months as a rough default
  }

  if (method === "beer") {
    return 30; // 1 month
  }

  // General vegetable ferments
  return 60;
}

/**
 * Build checkpoints within the active fermentation phase.
 *
 * @param {number} activeFermentDays
 * @returns {Array<Object>}
 */
function buildActiveFermentCheckpoints(activeFermentDays) {
  const checkpoints = [];

  // Day 1–2: first activity check
  checkpoints.push({
    id: "day2_burp_jars",
    label: "Burp jars / check activity",
    offsetDays: activeFermentDays >= 3 ? 2 : 1,
    preferredTimeOfDay: "evening",
  });

  // Mid-phase taste/texture check
  const mid = Math.max(2, Math.round(activeFermentDays / 2));
  if (mid !== checkpoints[0].offsetDays) {
    checkpoints.push({
      id: "mid_phase_taste",
      label: "Taste / texture check",
      offsetDays: mid,
      preferredTimeOfDay: "evening",
    });
  }

  // Optional final-day check
  checkpoints.push({
    id: "final_day_check",
    label: "Final ferment check before moving to cold storage",
    offsetDays: Math.max(1, activeFermentDays - 1),
    preferredTimeOfDay: "morning",
  });

  return dedupeCheckpoints(checkpoints);
}

/**
 * Build session suggestions that SessionRunner can materialize.
 *
 * @param {{
 *   product: any,
 *   fermentation: any,
 *   schedule: any[],
 *   timezone: string
 * }} ctx
 */
function buildSessionSuggestions(ctx) {
  const { product, fermentation, schedule, timezone } = ctx;
  const sessions = [];

  const activePhase = schedule.find((p) => p.phaseId === "active_ferment");
  const coldPhase = schedule.find((p) => p.phaseId === "cold_storage");

  if (activePhase) {
    // Start session
    sessions.push({
      id: `ferment_start_${safeSlug(product.type)}_${activePhase.startAt}`,
      kind: "start_batch",
      title: `Start ${product.type} fermentation`,
      scheduledFor: activePhase.startAt,
      timezone,
      stepHints: [
        {
          title: "Weigh vegetables / must",
          desc: "Weigh the product to confirm batch size and adjust salt as needed.",
          durationSec: 600,
        },
        {
          title: "Prepare brine / starter",
          desc: `Mix brine or starter for a ${fermentation.method} ferment.`,
          durationSec: 900,
        },
        {
          title: "Pack jars or crock",
          desc: "Pack product tightly and ensure proper headspace for gas release.",
          durationSec: 900,
        },
      ],
    });

    // Checkpoints -> check/burp sessions
    (activePhase.checkpoints || []).forEach((cp) => {
      const checkpointDate = addDays(
        new Date(activePhase.startAt),
        cp.offsetDays
      );
      sessions.push({
        id: `ferment_check_${cp.id}_${checkpointDate.toISOString()}`,
        kind: "checkpoint",
        title: cp.label,
        scheduledFor: checkpointDate.toISOString(),
        timezone,
        stepHints: [
          {
            title: "Inspect ferment",
            desc: "Check bubbles, aroma, and surface activity. Skim foam if needed.",
            durationSec: 300,
          },
          {
            title: "Burp jars (if sealed)",
            desc: "Carefully open and re-seal jars to release gas buildup.",
            durationSec: 300,
          },
        ],
      });
    });
  }

  if (coldPhase) {
    // Move to cold storage session
    sessions.push({
      id: `ferment_move_cold_${safeSlug(product.type)}_${coldPhase.startAt}`,
      kind: "move_to_cold",
      title: `Move ${product.type} to cold storage`,
      scheduledFor: coldPhase.startAt,
      timezone,
      stepHints: [
        {
          title: "Taste final ferment",
          desc: "Confirm flavor and texture are where you want them.",
          durationSec: 300,
        },
        {
          title: "Move to cold storage",
          desc: "Move jars or crock to fridge, root cellar, or cool pantry.",
          durationSec: 600,
        },
      ],
    });
  }

  return sessions;
}

/**
 * Build inventory hints for storehouse integration.
 *
 * @param {{ product: any, targetReadyWindow: { start: string, end: string } }} ctx
 */
function buildInventoryHints(ctx) {
  const { product, targetReadyWindow } = ctx;

  return [
    {
      itemKey: `ferment_${safeSlug(product.type)}_${targetReadyWindow.start}`,
      quantity: product.batchSize,
      unit: product.unit,
      readyFrom: targetReadyWindow.start,
      readyTo: targetReadyWindow.end,
      eligibleForMealPlanning: true,
    },
  ];
}

/**
 * Try to pick a default storage location based on method or product.
 *
 * @param {string} method
 * @returns {string}
 */
function pickDefaultStorageLocation(method) {
  const m = (method || "").toLowerCase();
  if (m.includes("wine") || m.includes("beer")) return "Cool Cellar";
  return "Fermentation Shelf / Fridge";
}

/**
 * Deduplicate checkpoints by (id, offsetDays).
 *
 * @param {Array<any>} checkpoints
 * @returns {Array<any>}
 */
function dedupeCheckpoints(checkpoints) {
  const seen = new Set();
  const result = [];
  for (const cp of checkpoints) {
    const key = `${cp.id}-${cp.offsetDays}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(cp);
  }
  return result;
}

/**
 * Export calculator result to Hub if familyFundMode is enabled.
 *
 * @param {Object} payload
 */
async function exportToHubIfEnabled(payload) {
  if (!familyFundMode) return;

  try {
    const envelope = HubPacketFormatter.fromCalculatorResult(payload);
    await FamilyFundConnector.send(envelope);
  } catch (err) {
    // Fail silently by design
    // eslint-disable-next-line no-console
    console.warn("FermentationDurationCalculator: Hub export failed", err);
  }
}

/**
 * @param {string} value
 * @returns {boolean}
 */
function isValidDate(value) {
  if (!value) return false;
  const d = new Date(value);
  return !Number.isNaN(d.getTime());
}

/**
 * @param {Date} date
 * @param {number} days
 * @returns {Date}
 */
function addDays(date, days) {
  const d = new Date(date.getTime());
  d.setTime(d.getTime() + days * 24 * 60 * 60 * 1000);
  return d;
}

/**
 * Safe slug for ids/keys.
 *
 * @param {string} str
 * @returns {string}
 */
function safeSlug(str) {
  return String(str || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
}

export default {
  runFermentationDurationCalculator,
};
