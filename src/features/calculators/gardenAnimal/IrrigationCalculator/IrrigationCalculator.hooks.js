// C:\Users\larho\suka-smart-assistant\src\features\calculators\gardenAnimal\IrrigationCalculator\IrrigationCalculator.hooks.js

import { useEffect, useMemo, useState } from "react";
import { emit } from "@/services/eventBus";
import { familyFundMode } from "@/services/featureFlags";
import { computeIrrigationSchedule } from "./IrrigationCalculator.shim";

/**
 * useIrrigationCalculator
 * ------------------------
 * How this fits:
 * - Hook backing the IrrigationCalculator.view.jsx UI.
 * - Bridges:
 *    • garden layout + soil + climate inputs  → irrigation water requirements,
 *    • irrigation schedule → “Now” sessions via SessionRunner,
 *    • irrigation plan → yield/stability signals for the Planning Graph.
 *
 * Responsibilities:
 * - Hold local calculator inputs (or accept them from props).
 * - Recompute irrigation schedule when inputs / climate snapshot change.
 * - Emit an "irrigation.plan.updated" event so other calculators (yield, soil,
 *   storehouse) can react.
 * - Expose handlers to:
 *    • trigger recompute,
 *    • tweak inputs,
 *    • launch "Now" garden sessions for single events or “next runnable”.
 *
 * It does NOT:
 * - Implement SessionRunner timers, wake-lock, notifications, etc.
 *   Those are handled by the global SessionRunner, which should listen for:
 *     • session.request.start
 *   and then mount its full-screen modal at the app root.
 */

/**
 * @typedef {Object} IrrigationInputs
 * @property {string} [planId]
 * @property {string} [householdId]
 * @property {string} [gardenId]
 * @property {Object<string, { bedId: string, areaSqFt: number, zoneId: string }>} [bedsById]
 * @property {Object<string, { zoneId: string, flowRateGpm: number }>} [zonesById]
 * @property {{ weeklyTargetIn?: number, allowDeficitIrrigation?: boolean }} [targets]
 * @property {{ evapotranspirationInPerWeek?: number, recentRainIn?: number }} [climateSnapshot]
 */

/**
 * @typedef {Object} IrrigationStatus
 * @property {boolean} isLoading
 * @property {boolean} isRunning
 * @property {string|null} errorMessage
 */

/**
 * @typedef {Object} UseIrrigationCalculatorResult
 * @property {IrrigationInputs} inputs
 * @property {Object} outputs
 * @property {Array<Object>} schedule
 * @property {IrrigationStatus} status
 * @property {{
 *   handleRecalculate: () => void,
 *   handleInputChange: (path: string, value: any) => void,
 *   handleRunNowForEvent: (eventId: string) => void,
 *   handleRunAllNow: () => void
 * }} handlers
 */

/**
 * Main hook.
 *
 * @param {Object} [props]
 * @param {IrrigationInputs} [props.inputs]
 * @param {Object} [props.climateSnapshot]
 * @param {(payload: { inputs: IrrigationInputs, outputs: any, schedule: any }) => void} [props.onPlanChange]
 * @returns {UseIrrigationCalculatorResult}
 */
export function useIrrigationCalculator(props = {}) {
  const { inputs: initialInputs, climateSnapshot: climateFromProps, onPlanChange } = props;

  const [inputs, setInputs] = useState(() =>
    normaliseInputs(initialInputs, climateFromProps)
  );
  const [outputs, setOutputs] = useState(() => ({
    waterRequirements: {
      perBedInchesPerWeek: {},
      perZoneGallonsPerWeek: {},
      totalGallonsPerWeek: 0,
    },
    stability: {
      riskLevel: "unknown",
      notes: [],
    },
  }));
  const [schedule, setSchedule] = useState(() => []);
  const [status, setStatus] = useState(() => ({
    isLoading: false,
    isRunning: false,
    errorMessage: null,
  }));

  // Derived climate snapshot (from inputs or props)
  const climateSnapshot = useMemo(
    () => inputs?.climateSnapshot || climateFromProps || {},
    [inputs?.climateSnapshot, climateFromProps]
  );

  /**
   * Internal: run the shim and update state + emit plan event.
   */
  const recalc = () => {
    setStatus((prev) => ({ ...prev, isLoading: true, errorMessage: null }));

    try {
      const result = computeIrrigationSchedule({
        inputs,
        climateSnapshot,
        options: {},
      });

      const {
        waterRequirements = {
          perBedInchesPerWeek: {},
          perZoneGallonsPerWeek: {},
          totalGallonsPerWeek: 0,
        },
        schedule: nextSchedule = [],
        stability = {
          riskLevel: "unknown",
          notes: [],
        },
      } = result || {};

      const nextOutputs = {
        waterRequirements,
        stability,
      };

      setOutputs(nextOutputs);
      setSchedule(Array.isArray(nextSchedule) ? nextSchedule : []);

      // Broadcast to planning graph / other calculators
      emitSafe({
        type: "irrigation.plan.updated",
        source: "calculators/irrigation",
        data: {
          inputs,
          outputs: nextOutputs,
          schedule: nextSchedule,
        },
      });

      // Optional callback for parent components
      if (typeof onPlanChange === "function") {
        onPlanChange({
          inputs,
          outputs: nextOutputs,
          schedule: nextSchedule,
        });
      }

      // Optionally mirror to Hub for shared planning (does not block UI)
      exportPlanToHubIfEnabled({
        inputs,
        outputs: nextOutputs,
        schedule: nextSchedule,
      });

      setStatus((prev) => ({ ...prev, isLoading: false, errorMessage: null }));
    } catch (err) {
      console.error("[IrrigationCalculator] Recalc failed:", err);
      setStatus((prev) => ({
        ...prev,
        isLoading: false,
        errorMessage: "Unable to compute irrigation schedule. Please review inputs.",
      }));
    }
  };

  // Initial recompute + whenever inputs / climate snapshot change
  useEffect(() => {
    recalc();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(inputs), JSON.stringify(climateSnapshot)]);

  /**
   * Handler: user explicitly requests recalculation.
   */
  const handleRecalculate = () => {
    recalc();
  };

  /**
   * Handler: generic input change using dot-path.
   *
   * Examples:
   * - "targets.weeklyTargetIn"
   * - "zonesById.zone-1.flowRateGpm"
   *
   * @param {string} path
   * @param {any} value
   */
  const handleInputChange = (path, value) => {
    if (!path || typeof path !== "string") return;
    setInputs((prev) => pathSet(prev || {}, path, value));
  };

  /**
   * Handler: launch "Now" for a specific event in the schedule.
   *
   * @param {string} eventId
   */
  const handleRunNowForEvent = (eventId) => {
    if (!eventId || !Array.isArray(schedule) || schedule.length === 0) return;
    const event = schedule.find((evt) => evt.eventId === eventId);
    if (!event) return;

    setStatus((prev) => ({ ...prev, isRunning: true }));

    try {
      const session = buildSessionFromIrrigationEvent(event, inputs);

      emitSafe({
        type: "session.request.start",
        source: "calculators/irrigation",
        data: { session },
      });
    } catch (err) {
      console.error("[IrrigationCalculator] Failed to create session:", err);
      setStatus((prev) => ({
        ...prev,
        errorMessage: "Unable to start irrigation session.",
      }));
    } finally {
      setStatus((prev) => ({ ...prev, isRunning: false }));
    }
  };

  /**
   * Handler: "Run next irrigation" – pick the next runnable event and fire.
   */
  const handleRunAllNow = () => {
    if (!Array.isArray(schedule) || schedule.length === 0) return;

    // Simple heuristic: choose the earliest startDateTimeLocal that is not in the far past.
    const now = Date.now();
    const upcoming = [...schedule].sort((a, b) => {
      const ta = Date.parse(a.startDateTimeLocal || a.targetDateTimeIso || "");
      const tb = Date.parse(b.startDateTimeLocal || b.targetDateTimeIso || "");
      return ta - tb;
    });

    let candidate = upcoming[0];
    for (let i = 0; i < upcoming.length; i += 1) {
      const t = Date.parse(upcoming[i].startDateTimeLocal || "");
      if (!Number.isNaN(t) && t >= now - 60 * 60 * 1000) {
        candidate = upcoming[i];
        break;
      }
    }

    if (!candidate) return;
    handleRunNowForEvent(candidate.eventId);
  };

  const handlers = useMemo(
    () => ({
      handleRecalculate,
      handleInputChange,
      handleRunNowForEvent,
      handleRunAllNow,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [schedule, inputs]
  );

  return {
    inputs,
    outputs,
    schedule,
    status,
    handlers,
  };
}

/* ------------------------------------------------------------------------- */
/* Helper functions                                                          */
/* ------------------------------------------------------------------------- */

/**
 * Ensure we always have a well-shaped inputs object.
 *
 * @param {IrrigationInputs|undefined} rawInputs
 * @param {Object|undefined} climateFromProps
 * @returns {IrrigationInputs}
 */
function normaliseInputs(rawInputs, climateFromProps) {
  const safe = rawInputs && typeof rawInputs === "object" ? rawInputs : {};
  const targets = safe.targets || {};

  return {
    planId: safe.planId || null,
    householdId: safe.householdId || null,
    gardenId: safe.gardenId || null,
    bedsById: safe.bedsById || {},
    zonesById: safe.zonesById || {},
    targets: {
      weeklyTargetIn:
        typeof targets.weeklyTargetIn === "number" ? targets.weeklyTargetIn : 1.0,
      allowDeficitIrrigation:
        typeof targets.allowDeficitIrrigation === "boolean"
          ? targets.allowDeficitIrrigation
          : false,
    },
    climateSnapshot: safe.climateSnapshot || climateFromProps || {},
  };
}

/**
 * Safe event emitter wrapper for SSA event bus.
 *
 * @param {{type: string, source: string, data: any}} payload
 */
function emitSafe({ type, source, data }) {
  try {
    emit({
      type,
      ts: new Date().toISOString(),
      source,
      data,
    });
  } catch (err) {
    console.error("[IrrigationCalculator] Failed to emit event:", type, err);
  }
}

/**
 * Very small dot-path setter for nested objects.
 *
 * @param {Object} obj
 * @param {string} path
 * @param {any} value
 * @returns {Object}
 */
function pathSet(obj, path, value) {
  const segments = path.split(".").filter(Boolean);
  if (segments.length === 0) return obj;

  const clone = { ...(obj || {}) };
  let cursor = clone;

  for (let i = 0; i < segments.length; i += 1) {
    const key = segments[i];
    const isLast = i === segments.length - 1;

    if (isLast) {
      cursor[key] = value;
    } else {
      const existing = cursor[key];
      if (!existing || typeof existing !== "object") {
        cursor[key] = {};
      } else {
        cursor[key] = Array.isArray(existing) ? [...existing] : { ...existing };
      }
      cursor = cursor[key];
    }
  }

  return clone;
}

/**
 * Build a SessionRunner-compatible session object for a single irrigation event.
 *
 * @param {Object} event
 * @param {IrrigationInputs} inputs
 * @returns {Object} Session object aligned with SSA contract
 */
function buildSessionFromIrrigationEvent(event, inputs) {
  const nowIso = new Date().toISOString();
  const sessionId = `irr-${event.zoneId || "zone"}-${event.eventId || "evt"}-${Date.now()}`;

  const durationSec = Math.max(
    60,
    Math.round((event.durationMinutes || 0) * 60)
  );

  const steps = [
    {
      id: `${sessionId}-01`,
      title: `Start irrigation – Zone ${event.zoneId}`,
      desc:
        "Open the valve or start the pump for this zone. Confirm emitters or sprinklers are running correctly.",
      durationSec: Math.round(durationSec * 0.1),
      blockers: ["weather", "quietHours", "sabbath", "equipment"],
      metadata: {
        tempTargetF: 0,
        donenessCue: "timer",
        cueNotes:
          "If heavy rain is currently falling, you may safely skip this event.",
      },
    },
    {
      id: `${sessionId}-02`,
      title: `Monitor irrigation – Zone ${event.zoneId}`,
      desc:
        "Observe the water distribution and ensure there are no leaks or dry patches. Adjust emitters if needed.",
      durationSec: Math.round(durationSec * 0.3),
      blockers: ["weather", "equipment"],
      metadata: {
        tempTargetF: 0,
        donenessCue: "timer",
        cueNotes:
          "Soil should appear uniformly moist but not flooded across the bed area.",
      },
    },
    {
      id: `${sessionId}-03`,
      title: `Complete irrigation – Zone ${event.zoneId}`,
      desc:
        "Turn off the valve or pump when the target time has elapsed or the soil reaches the desired moisture level.",
      durationSec: Math.max(60, durationSec - Math.round(durationSec * 0.4)),
      blockers: ["equipment"],
      metadata: {
        tempTargetF: 0,
        donenessCue: "timer",
        cueNotes:
          "If water begins to pool on the surface before time is complete, you may end early.",
      },
    },
  ];

  return {
    id: sessionId,
    domain: "garden",
    title: `Irrigation – Zone ${event.zoneId} (${roundTo(event.expectedDepthIn || 0, 2)} in)`,
    source: {
      type: "gardenPlan",
      refId: inputs?.planId || null,
    },
    steps,
    prefs: {
      voiceGuidance: true,
      haptic: true,
      autoAdvance: false,
    },
    status: "pending",
    progress: {
      currentStepIndex: 0,
      elapsedSec: 0,
      startedAt: null,
      pausedAt: null,
    },
    analytics: {
      skippedSteps: [],
      adjustments: [],
    },
    createdAt: nowIso,
    updatedAt: nowIso,
  };
}

/**
 * Simple rounding helper reused from view.
 *
 * @param {number} value
 * @param {number} decimals
 * @returns {number}
 */
function roundTo(value, decimals) {
  if (typeof value !== "number" || Number.isNaN(value)) return 0;
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}

/**
 * Optionally export the irrigation plan to the Hub if familyFundMode is enabled.
 *
 * This is intentionally best-effort and non-blocking.
 *
 * @param {Object} payload
 */
async function exportPlanToHubIfEnabled(payload) {
  if (!familyFundMode) return;

  try {
    // Dynamic import to avoid hard-coupling build-time paths.
    const hubModule = await import("@/services/hub").catch(() => null);
    if (!hubModule) return;

    const { HubPacketFormatter, FamilyFundConnector } = hubModule;
    if (!HubPacketFormatter || !FamilyFundConnector) return;

    const packet = HubPacketFormatter.format({
      kind: "irrigation.plan",
      payload,
    });

    await FamilyFundConnector.send(packet);
  } catch (err) {
    // Fail silently per contract (log only in dev)
    if (typeof process !== "undefined" && process.env?.NODE_ENV === "development") {
      console.warn("[IrrigationCalculator] Hub export failed:", err);
    }
  }
}
