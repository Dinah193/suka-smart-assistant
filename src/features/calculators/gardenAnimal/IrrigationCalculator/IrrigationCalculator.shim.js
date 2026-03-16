// C:\Users\larho\suka-smart-assistant\src\features\calculators\gardenAnimal\IrrigationCalculator\IrrigationCalculator.shim.js

/**
 * IrrigationCalculator.shim
 * -------------------------
 * How this fits:
 * - Pure calculation shim for the IrrigationCalculator node in the Planning Graph.
 * - Consumes structured inputs (beds, soil, climate, preferences) and produces:
 *     - weekly water requirements (inches + gallons),
 *     - a concrete irrigation schedule SSA can convert into SessionRunner sessions,
 *     - alerts (restrictions, conflicts, risk notices).
 * - Does NOT talk directly to SessionRunner or Hub; callers can:
 *     - pass the `outputs.schedule` into a SessionBuilder → SessionRunner,
 *     - optionally export analytics to Hub using existing helpers.
 *
 * Design:
 * - Pure functions + a small wrapper `runIrrigationCalculator()` for orchestration.
 * - Defensive checks: empty inputs → safe defaults, no throws on bad data.
 * - Easy to extend for new fields in schema without breaking core logic.
 */

export const IRRIGATION_CALCULATOR_KEY = "IrrigationCalculator";

/**
 * @typedef {Object} IrrigationCalculatorRunOptions
 * @property {Date} [baseDate]      - Base date to anchor the 7-day schedule (default: now).
 * @property {number} [horizonDays] - Number of days to plan ahead (default: 7).
 */

/**
 * Top-level orchestrator that:
 * - validates the shape,
 * - computes requirements and schedule,
 * - assembles the final outputs bundle.
 *
 * @param {Object} payload   Matching IrrigationCalculator.schema.json root shape.
 * @param {IrrigationCalculatorRunOptions} [options]
 * @returns {{ calculatorKey: string, version: string, inputs: any, outputs: any }}
 */
export function runIrrigationCalculator(payload, options = {}) {
  const safePayload = payload && typeof payload === "object" ? payload : {};
  const calculatorKey =
    typeof safePayload.calculatorKey === "string"
      ? safePayload.calculatorKey
      : IRRIGATION_CALCULATOR_KEY;

  const version =
    typeof safePayload.version === "string" ? safePayload.version : "1.0.0";

  const inputs = normalizeInputs(safePayload.inputs || {});
  const baseDate =
    options.baseDate instanceof Date ? options.baseDate : new Date();
  const horizonDays =
    typeof options.horizonDays === "number" && options.horizonDays > 0
      ? Math.floor(options.horizonDays)
      : 7;

  const waterRequirements = computeWaterRequirements(inputs);
  const schedule = computeIrrigationSchedule(inputs, waterRequirements, {
    baseDate,
    horizonDays,
  });
  const alerts = buildAlerts(inputs, waterRequirements, schedule);

  const outputs = {
    waterRequirements,
    schedule,
    alerts,
  };

  return {
    calculatorKey,
    version,
    inputs,
    outputs,
  };
}

/**
 * Normalize / sanitize raw inputs into safe shapes.
 * @param {any} inputs
 * @returns {any}
 */
function normalizeInputs(inputs) {
  const result = { ...inputs };

  // Beds
  if (!Array.isArray(result.beds)) {
    result.beds = [];
  } else {
    result.beds = result.beds
      .filter(Boolean)
      .map((bed, idx) => normalizeBed(bed, idx));
  }

  // Irrigation system
  result.irrigationSystem = normalizeIrrigationSystem(result.irrigationSystem);

  // Climate
  result.climate = normalizeClimate(result.climate);

  // User preferences
  result.userPreferences = normalizeUserPreferences(result.userPreferences);

  return result;
}

/**
 * @param {any} bed
 * @param {number} index
 * @returns {any}
 */
function normalizeBed(bed, index) {
  const safe = bed && typeof bed === "object" ? { ...bed } : {};

  if (typeof safe.bedId !== "string" || !safe.bedId.trim()) {
    safe.bedId = `bed_${index + 1}`;
  }
  if (typeof safe.surfaceAreaSqFt !== "number" || safe.surfaceAreaSqFt <= 0) {
    safe.surfaceAreaSqFt = 10; // assume a small raised bed rather than 0
  }

  if (!Array.isArray(safe.crops)) {
    safe.crops = [];
  } else {
    safe.crops = safe.crops
      .filter(Boolean)
      .map((crop, cIdx) => normalizeCrop(crop, cIdx));
  }

  safe.soil = normalizeSoil(safe.soil);
  return safe;
}

/**
 * @param {any} crop
 * @param {number} index
 * @returns {any}
 */
function normalizeCrop(crop, index) {
  const safe = crop && typeof crop === "object" ? { ...crop } : {};
  if (typeof safe.name !== "string" || !safe.name.trim()) {
    safe.name = `Crop ${index + 1}`;
  }
  if (!["low", "medium", "high"].includes(safe.waterDemandLevel)) {
    safe.waterDemandLevel = "medium";
  }
  return safe;
}

/**
 * @param {any} soil
 * @returns {any}
 */
function normalizeSoil(soil) {
  const safe = soil && typeof soil === "object" ? { ...soil } : {};
  if (
    ![
      "sand",
      "loamy_sand",
      "sandy_loam",
      "loam",
      "silt_loam",
      "clay_loam",
      "silty_clay",
      "sandy_clay",
      "clay",
      "unknown",
    ].includes(safe.textureClass)
  ) {
    safe.textureClass = "unknown";
  }
  return safe;
}

/**
 * @param {any} sys
 * @returns {any}
 */
function normalizeIrrigationSystem(sys) {
  const safe = sys && typeof sys === "object" ? { ...sys } : {};
  if (
    !["drip", "soaker", "sprinkler", "flood", "hand", "other"].includes(
      safe.method
    )
  ) {
    safe.method = "drip";
  }
  if (
    typeof safe.defaultApplicationRateInPerHour !== "number" ||
    safe.defaultApplicationRateInPerHour <= 0
  ) {
    // rough default: drip/soaker ~0.25 in/hr over bed area
    safe.defaultApplicationRateInPerHour = 0.25;
  }
  if (
    typeof safe.defaultFlowRateGphPerEmitter !== "number" ||
    safe.defaultFlowRateGphPerEmitter < 0
  ) {
    safe.defaultFlowRateGphPerEmitter = 0.5;
  }
  if (!safe.zoneFlowRatesGph || typeof safe.zoneFlowRatesGph !== "object") {
    safe.zoneFlowRatesGph = {};
  }
  return safe;
}

/**
 * @param {any} climate
 * @returns {any}
 */
function normalizeClimate(climate) {
  const safe = climate && typeof climate === "object" ? { ...climate } : {};
  if (
    typeof safe.referenceEToMmPerDay !== "number" ||
    safe.referenceEToMmPerDay < 0
  ) {
    safe.referenceEToMmPerDay = 4; // moderate ET default
  }
  if (!Array.isArray(safe.recentRainfallIn)) {
    safe.recentRainfallIn = [];
  }
  if (!Array.isArray(safe.forecastDaily)) {
    safe.forecastDaily = [];
  }
  if (!Array.isArray(safe.alerts)) {
    safe.alerts = [];
  }
  return safe;
}

/**
 * @param {any} prefs
 * @returns {any}
 */
function normalizeUserPreferences(prefs) {
  const safe = prefs && typeof prefs === "object" ? { ...prefs } : {};
  if (
    !["early_morning", "late_evening", "night", "no_preference"].includes(
      safe.preferredTimeOfDay
    )
  ) {
    safe.preferredTimeOfDay = "early_morning";
  }
  if (
    typeof safe.maxIrrigationEventsPerWeek !== "number" ||
    safe.maxIrrigationEventsPerWeek <= 0
  ) {
    safe.maxIrrigationEventsPerWeek = 3;
  }
  if (
    typeof safe.skipIfRainAboveIn !== "number" ||
    safe.skipIfRainAboveIn < 0
  ) {
    safe.skipIfRainAboveIn = 0.25;
  }
  if (!safe.waterRestrictions || typeof safe.waterRestrictions !== "object") {
    safe.waterRestrictions = {};
  }
  return safe;
}

/**
 * Compute weekly water requirements per bed and per zone.
 *
 * @param {any} inputs
 * @returns {{
 *   perBedInchesPerWeek: Record<string, number>,
 *   perZoneGallonsPerWeek: Record<string, number>,
 *   totalGallonsPerWeek: number
 * }}
 */
function computeWaterRequirements(inputs) {
  const { beds, irrigationSystem } = inputs;
  const perBedInchesPerWeek = {};
  const perZoneGallonsPerWeek = {};
  let totalGallonsPerWeek = 0;

  if (!Array.isArray(beds) || beds.length === 0) {
    return { perBedInchesPerWeek, perZoneGallonsPerWeek, totalGallonsPerWeek };
  }

  for (const bed of beds) {
    const bedId = bed.bedId;
    const area =
      typeof bed.surfaceAreaSqFt === "number" ? bed.surfaceAreaSqFt : 0;
    if (!bedId || area <= 0) continue;

    const inches = estimateWeeklyInchesForBed(bed, inputs.climate);
    perBedInchesPerWeek[bedId] = inches;

    // Convert inches over ft² to gallons: 1 inch over 1 ft² ≈ 0.623 gallons.
    const bedGallons = area * inches * 0.623;
    const zoneId =
      typeof bed.zoneId === "string" && bed.zoneId ? bed.zoneId : "default";

    if (!perZoneGallonsPerWeek[zoneId]) {
      perZoneGallonsPerWeek[zoneId] = 0;
    }
    perZoneGallonsPerWeek[zoneId] += bedGallons;
    totalGallonsPerWeek += bedGallons;
  }

  // If we have zones but no explicit flow, we still return gallons; duration will use default application rate.
  return {
    perBedInchesPerWeek,
    perZoneGallonsPerWeek,
    totalGallonsPerWeek,
  };
}

/**
 * Estimate weekly inches of water requirement for a single bed.
 *
 * @param {any} bed
 * @param {any} climate
 * @returns {number}
 */
function estimateWeeklyInchesForBed(bed, climate) {
  // Baseline: ~1 inch/week is common recommendation.
  let inches = 1.0;

  // Crop water demand weights
  if (Array.isArray(bed.crops) && bed.crops.length > 0) {
    let totalWeight = 0;
    let count = 0;
    for (const crop of bed.crops) {
      let weight = 1.0;
      switch (crop.waterDemandLevel) {
        case "low":
          weight = 0.75;
          break;
        case "medium":
          weight = 1.0;
          break;
        case "high":
          weight = 1.25;
          break;
        default:
          weight = 1.0;
      }
      totalWeight += weight;
      count += 1;
    }
    const avgWeight = count > 0 ? totalWeight / count : 1.0;
    inches *= avgWeight;
  }

  // Shade pattern
  switch (bed.shadePattern) {
    case "full_sun":
      inches += 0.25;
      break;
    case "partial_shade":
      // no change
      break;
    case "full_shade":
      inches -= 0.25;
      break;
    default:
      break;
  }

  // Mulch and soil texture adjustments
  if (bed.soil) {
    const soil = bed.soil;
    const mulchDepth =
      typeof soil.mulchDepthIn === "number" ? soil.mulchDepthIn : 0;
    if (mulchDepth >= 3) {
      inches -= 0.2;
    } else if (mulchDepth >= 1) {
      inches -= 0.1;
    }

    switch (soil.textureClass) {
      case "sand":
      case "loamy_sand":
      case "sandy_loam":
        inches += 0.25; // drains faster → more water
        break;
      case "clay":
      case "silty_clay":
      case "sandy_clay":
        inches -= 0.15; // holds water longer
        break;
      default:
        break;
    }
  }

  // Climate ET adjustment
  const eto =
    climate && typeof climate.referenceEToMmPerDay === "number"
      ? climate.referenceEToMmPerDay
      : 4;

  if (eto >= 6) {
    inches += 0.25;
  } else if (eto <= 3) {
    inches -= 0.1;
  }

  // Clamp to safe bounds
  if (inches < 0.25) inches = 0.25;
  if (inches > 2.0) inches = 2.0;

  return roundTo(inches, 2);
}

/**
 * Compute concrete irrigation events within the planning horizon.
 *
 * NOTE:
 * - This MUST be exported because IrrigationCalculator.hooks.js imports it.
 *
 * @param {any} inputs
 * @param {{
 *   perBedInchesPerWeek: Record<string, number>,
 *   perZoneGallonsPerWeek: Record<string, number>,
 *   totalGallonsPerWeek: number
 * }} waterRequirements
 * @param {{ baseDate: Date, horizonDays: number }} options
 * @returns {Array<any>}
 */
export function computeIrrigationSchedule(inputs, waterRequirements, options) {
  const { baseDate, horizonDays } = options;
  const { beds, irrigationSystem, userPreferences: prefs, climate } = inputs;

  const schedule = [];
  const zoneGallons = waterRequirements.perZoneGallonsPerWeek || {};
  const maxEventsPerWeek = prefs.maxIrrigationEventsPerWeek || 3;
  const applicationRateInPerHour =
    irrigationSystem.defaultApplicationRateInPerHour || 0.25;

  const zoneIds = Object.keys(zoneGallons);
  if (zoneIds.length === 0) {
    return schedule;
  }

  // Build a helper map of zone -> [bedIds, weighted inches]
  const zoneMeta = buildZoneMeta(beds, waterRequirements.perBedInchesPerWeek);

  // Simple weekly horizon mapped to horizonDays
  const daysBetweenEvents =
    maxEventsPerWeek > 0 ? Math.floor(7 / maxEventsPerWeek) || 1 : 7;

  for (const zoneId of zoneIds) {
    const totalGallonsPerWeek = zoneGallons[zoneId] || 0;
    if (totalGallonsPerWeek <= 0) continue;

    const eventsCount = Math.min(maxEventsPerWeek, horizonDays);
    const gallonsPerEvent = totalGallonsPerWeek / eventsCount;

    // Convert gallons into inches for an "average" bed in the zone, for guidance
    const meta = zoneMeta[zoneId];
    const effectiveArea =
      meta && meta.totalAreaSqFt > 0 ? meta.totalAreaSqFt : 1;
    const inchesPerEvent = gallonsPerEvent / (effectiveArea * 0.623); // reverse of ft²→gal

    for (let i = 0; i < eventsCount; i++) {
      const eventDate = new Date(baseDate.getTime());
      eventDate.setDate(eventDate.getDate() + i * daysBetweenEvents);

      const startDateTimeLocal = getPreferredStartTime(eventDate, prefs);
      const durationHours =
        applicationRateInPerHour > 0
          ? inchesPerEvent / applicationRateInPerHour
          : 0;
      const durationMinutes = durationHours * 60;

      const eventId = `irrigation_${zoneId}_${formatDateKey(eventDate)}_${
        i + 1
      }`;

      const event = {
        eventId,
        zoneId,
        bedIds: meta ? meta.bedIds : [],
        startDateTimeLocal: startDateTimeLocal.toISOString(),
        durationMinutes: roundTo(durationMinutes, 1),
        expectedDepthIn: roundTo(inchesPerEvent, 2),
        expectedVolumeGallons: roundTo(gallonsPerEvent, 1),
        priority: "normal",
        notes: buildEventNote(zoneId, meta),
        sessionTemplate: {
          title: `Irrigate zone ${zoneId}`,
          domain: "garden",
          estimatedDurationSec: Math.round(durationMinutes * 60),
          stepHints: [
            "Open valve / start irrigation for this zone.",
            "Walk the beds, check emitters and look for leaks.",
            "Allow system to run for the full duration.",
            "Close valve / stop irrigation and verify everything is off.",
          ],
        },
      };

      // Check simple rain-skip rule and downgrade priority if heavy rain expected
      const forecast = findForecastForDate(
        climate && climate.forecastDaily,
        eventDate
      );
      if (
        forecast &&
        typeof forecast.expectedRainIn === "number" &&
        forecast.expectedRainIn >= (prefs.skipIfRainAboveIn || 0.25)
      ) {
        event.priority = "low";
        event.notes += ` (Rain expected: ${roundTo(
          forecast.expectedRainIn,
          2
        )} in; consider skipping this event.)`;
      }

      schedule.push(event);
    }
  }

  return schedule;
}

/**
 * Build zone metadata (bedIds + area) for duration & guidance.
 *
 * @param {Array<any>} beds
 * @param {Record<string, number>} perBedInchesPerWeek
 */
function buildZoneMeta(beds, perBedInchesPerWeek) {
  const meta = {};
  if (!Array.isArray(beds)) return meta;

  for (const bed of beds) {
    const zoneId =
      typeof bed.zoneId === "string" && bed.zoneId ? bed.zoneId : "default";
    const area =
      typeof bed.surfaceAreaSqFt === "number" ? bed.surfaceAreaSqFt : 0;
    const inches = perBedInchesPerWeek[bed.bedId] || 0;

    if (!meta[zoneId]) {
      meta[zoneId] = {
        bedIds: [],
        totalAreaSqFt: 0,
        averageInchesPerWeek: 0,
      };
    }

    const z = meta[zoneId];
    z.bedIds.push(bed.bedId);
    z.totalAreaSqFt += area;

    // simple incremental average
    const n = z.bedIds.length;
    z.averageInchesPerWeek = (z.averageInchesPerWeek * (n - 1) + inches) / n;
  }

  return meta;
}

/**
 * Build helpful alerts about water usage, restrictions and anomalies.
 *
 * @param {any} inputs
 * @param {any} waterRequirements
 * @param {Array<any>} schedule
 * @returns {Array<any>}
 */
function buildAlerts(inputs, waterRequirements, schedule) {
  const alerts = [];

  const totalGallons = waterRequirements.totalGallonsPerWeek || 0;
  if (totalGallons > 0 && totalGallons > 1000) {
    alerts.push({
      level: "warning",
      code: "HIGH_WATER_USAGE",
      message: `Estimated weekly irrigation use is ${roundTo(
        totalGallons,
        1
      )} gallons. Consider adding mulch, improving soil organic matter, or reducing plant density.`,
      relatedBedIds: (inputs.beds || []).map((b) => b.bedId),
      relatedZoneIds: Object.keys(
        waterRequirements.perZoneGallonsPerWeek || {}
      ),
    });
  }

  // Water restrictions vs schedule
  const restrictions =
    inputs.userPreferences && inputs.userPreferences.waterRestrictions;
  if (restrictions && Array.isArray(schedule) && schedule.length > 0) {
    const restrictedEvents = [];
    for (const evt of schedule) {
      if (!evt.startDateTimeLocal) continue;
      const d = new Date(evt.startDateTimeLocal);
      const weekday = d.getDay(); // 0 = Sunday
      const weekdayKey = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"][
        weekday
      ];

      if (Array.isArray(restrictions.allowedWeekdays)) {
        if (!restrictions.allowedWeekdays.includes(weekdayKey)) {
          restrictedEvents.push(evt);
          continue;
        }
      }

      // Time window checks are omitted here for simplicity; can be added later.
    }

    if (restrictedEvents.length > 0) {
      alerts.push({
        level: "warning",
        code: "WATER_RESTRICTION_CONFLICT",
        message:
          "Some irrigation events fall on days not allowed by configured water restrictions. Review your irrigation plan.",
        relatedBedIds: mergeUnique(
          [],
          ...restrictedEvents.map((e) => e.bedIds || [])
        ),
        relatedZoneIds: mergeUnique(
          [],
          ...restrictedEvents.map((e) => [e.zoneId])
        ),
      });
    }
  }

  // Propagate any upstream climate alerts as info
  if (inputs.climate && Array.isArray(inputs.climate.alerts)) {
    for (const ca of inputs.climate.alerts) {
      alerts.push({
        level: ca.severity || "info",
        code: ca.code || "CLIMATE_ALERT",
        message: ca.message || "Weather alert may affect irrigation.",
        relatedBedIds: [],
        relatedZoneIds: [],
      });
    }
  }

  // If no schedule was produced but we have beds, flag.
  if ((!schedule || schedule.length === 0) && (inputs.beds || []).length > 0) {
    alerts.push({
      level: "info",
      code: "NO_IRRIGATION_EVENTS",
      message:
        "No irrigation events were generated for this period. This may be okay if rainfall is sufficient or irrigation is done manually.",
      relatedBedIds: (inputs.beds || []).map((b) => b.bedId),
      relatedZoneIds: [],
    });
  }

  return alerts;
}

/**
 * Choose a start time for an event based on user preferences.
 *
 * @param {Date} date
 * @param {any} prefs
 * @returns {Date}
 */
function getPreferredStartTime(date, prefs) {
  const d = new Date(date.getTime());
  const timeOfDay =
    prefs && prefs.preferredTimeOfDay
      ? prefs.preferredTimeOfDay
      : "early_morning";

  switch (timeOfDay) {
    case "early_morning":
      d.setHours(6, 0, 0, 0);
      break;
    case "late_evening":
      d.setHours(19, 0, 0, 0);
      break;
    case "night":
      d.setHours(22, 0, 0, 0);
      break;
    case "no_preference":
    default:
      d.setHours(7, 0, 0, 0);
      break;
  }

  return d;
}

/**
 * Find forecast entry for a specific local date.
 *
 * @param {Array<any>} forecastDaily
 * @param {Date} date
 * @returns {any | undefined}
 */
function findForecastForDate(forecastDaily, date) {
  if (!Array.isArray(forecastDaily) || forecastDaily.length === 0)
    return undefined;
  const targetKey = formatDateKey(date);
  return forecastDaily.find((f) => {
    if (!f || typeof f.date !== "string") return false;
    // f.date is date-only yyyy-mm-dd
    return f.date === targetKey;
  });
}

/**
 * Format a date as yyyy-mm-dd.
 *
 * @param {Date} d
 * @returns {string}
 */
function formatDateKey(d) {
  const year = d.getFullYear();
  const month = `${d.getMonth() + 1}`.padStart(2, "0");
  const day = `${d.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Merge arrays into a unique flat array.
 *
 * @param {Array<any>} base
 * @param  {...Array<any>} rest
 * @returns {Array<any>}
 */
function mergeUnique(base, ...rest) {
  const set = new Set(base);
  for (const arr of rest) {
    if (!Array.isArray(arr)) continue;
    for (const item of arr) {
      if (item != null) set.add(item);
    }
  }
  return Array.from(set);
}

/**
 * Round to given decimals.
 *
 * @param {number} value
 * @param {number} decimals
 * @returns {number}
 */
function roundTo(value, decimals) {
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}

/**
 * Optional helper: convert a single schedule event into a SessionRunner session object.
 * Callers can map `outputs.schedule` via this helper before handing to SessionRunner.
 *
 * @param {any} event
 * @returns {any} Session-like object
 */
export function irrigationEventToSession(event) {
  if (!event || typeof event !== "object") return null;

  const nowIso = new Date().toISOString();
  const id = `session_irrigation_${event.eventId || "unknown"}`;
  const title =
    event.sessionTemplate?.title || `Irrigation: ${event.zoneId || "zone"}`;

  return {
    id,
    domain: "garden",
    title,
    source: {
      type: "gardenPlan",
      refId: event.eventId || null,
    },
    steps: [
      {
        id: `${id}_step_1`,
        title: "Start irrigation",
        desc: `Begin irrigation for zone ${event.zoneId}. Ensure valves or controller for this zone are open.`,
        durationSec: 60,
        blockers: ["weather", "equipment"],
        metadata: {
          tempTargetF: 0,
          donenessCue: "timer",
          cueNotes: "Watch for leaks or unusual spray patterns.",
        },
      },
      {
        id: `${id}_step_2`,
        title: "Monitor system",
        desc: "Walk the beds, check emitters/sprinklers, adjust coverage, and confirm water reaches root zones.",
        durationSec: Math.max(
          60,
          Math.round((event.durationMinutes || 0) * 60) - 120
        ),
        blockers: ["weather", "equipment"],
        metadata: {
          tempTargetF: 0,
          donenessCue: "timer",
          cueNotes:
            "Look for dry spots or pooling water and adjust accordingly.",
        },
      },
      {
        id: `${id}_step_3`,
        title: "Stop irrigation",
        desc: "Turn off valves or controller and verify all water flow has stopped.",
        durationSec: 60,
        blockers: ["equipment"],
        metadata: {
          tempTargetF: 0,
          donenessCue: "timer",
          cueNotes: "Double check for drips after shutdown.",
        },
      },
    ],
    prefs: { voiceGuidance: true, haptic: true, autoAdvance: false },
    status: "pending",
    progress: {
      currentStepIndex: 0,
      elapsedSec: 0,
      startedAt: null,
      pausedAt: null,
    },
    analytics: { skippedSteps: [], adjustments: [] },
    createdAt: nowIso,
    updatedAt: nowIso,
  };
}

/**
 * Default export for generic calculator runner integration.
 * - `key` allows registry lookups.
 * - `run` is the core calculation.
 * - `toSessions` is a convenience adapter for SessionRunner.
 */
const IrrigationCalculatorShim = {
  key: IRRIGATION_CALCULATOR_KEY,
  run: runIrrigationCalculator,
  toSessions(outputs) {
    if (!outputs || !Array.isArray(outputs.schedule)) return [];
    return outputs.schedule
      .map((evt) => irrigationEventToSession(evt))
      .filter(Boolean);
  },
};

export default IrrigationCalculatorShim;

/* -------------------------------------------------------------------------- */
/* Local helpers referenced above                                              */
/* -------------------------------------------------------------------------- */

function buildEventNote(zoneId, meta) {
  const beds = meta && Array.isArray(meta.bedIds) ? meta.bedIds.length : 0;
  const avg =
    meta && typeof meta.averageInchesPerWeek === "number"
      ? meta.averageInchesPerWeek
      : 0;
  const parts = [`Zone ${zoneId}`];
  if (beds > 0) parts.push(`${beds} bed${beds === 1 ? "" : "s"}`);
  if (avg > 0) parts.push(`avg ${roundTo(avg, 2)} in/week`);
  return parts.join(" · ");
}
