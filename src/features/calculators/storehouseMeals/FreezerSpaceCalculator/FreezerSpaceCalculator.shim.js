// C:\Users\larho\suka-smart-assistant\src\features\calculators\storehouseMeals\FreezerSpaceCalculator\FreezerSpaceCalculator.shim.js

/**
 * FreezerSpaceCalculator Shim
 *
 * How this fits:
 * - This is a pure-calculation + orchestration shim for the Planning Graph.
 * - It consumes a payload shaped like FreezerSpaceCalculator.schema.json.
 * - It computes per-freezer usage, fit/overflow, suggested layouts, and
 *   session/inventory hints.
 * - It emits calculator + storehouse events, and optionally exports to the Hub
 *   when familyFundMode is enabled.
 *
 * This shim does NOT own UI; it is invoked by controllers / planners or by an
 * event listener on `calculator.freezerSpace.requested`.
 */

import { emit } from "@/services/eventBus";
import { familyFundMode } from "@/services/featureFlags";
// Adjust these imports to match your actual hub helper paths/names
import { formatForHub } from "@/services/hub/HubPacketFormatter";
import { sendToHub } from "@/services/hub/FamilyFundConnector";

const SHIM_SOURCE = "calculators/storehouseMeals/FreezerSpaceCalculator.shim";

/**
 * @typedef {import("./FreezerSpaceCalculator.schema.json")} FreezerSpaceCalculatorSchema
 * (For editor IntelliSense only; actual import is not required at runtime.)
 */

/**
 * Small helper: ISO timestamp now.
 * @returns {string}
 */
function nowIso() {
  return new Date().toISOString();
}

/**
 * Emit a typed event via the shared eventBus.
 * @param {string} type
 * @param {any} data
 */
function emitEvent(type, data) {
  try {
    emit({
      type,
      ts: nowIso(),
      source: SHIM_SOURCE,
      data,
    });
  } catch (err) {
    // Fail-safe: never crash SSA if eventBus misbehaves
    // eslint-disable-next-line no-console
    console.error("[FreezerSpaceCalculator.shim] emit error", type, err);
  }
}

/**
 * Hub export helper, no-op when familyFundMode is false.
 * @param {object} payload
 */
async function exportToHubIfEnabled(payload) {
  if (!familyFundMode) return;
  try {
    const packet = formatForHub({
      kind: "calculator.freezerSpace.completed",
      source: SHIM_SOURCE,
      payload,
      ts: nowIso(),
    });
    await sendToHub(packet);
    emitEvent("session.exported", {
      calculatorId: "FreezerSpaceCalculator",
      hubPacketId: packet?.id || null,
    });
  } catch (err) {
    // Silent failure by design (per Master Codegen Prompt)
    // eslint-disable-next-line no-console
    console.warn("[FreezerSpaceCalculator.shim] Hub export failed", err);
  }
}

/**
 * Compute effective capacity for a freezer after reserve % rules.
 * @param {object} freezer
 * @param {number|undefined} globalReservePct
 * @returns {{effectiveCapacity: number, reservedLiters: number, reservePct: number}}
 */
function computeEffectiveCapacity(freezer, globalReservePct) {
  const capacity = typeof freezer.capacityLiters === "number" ? freezer.capacityLiters : 0;
  const reservePct =
    typeof freezer.reservePct === "number"
      ? freezer.reservePct
      : typeof globalReservePct === "number"
      ? globalReservePct
      : 0;

  const reservedLiters = (capacity * reservePct) / 100;
  const effectiveCapacity = Math.max(capacity - reservedLiters, 0);

  return { effectiveCapacity, reservedLiters, reservePct };
}

/**
 * Pick a target freezer for the given item based on preferences and remaining capacity.
 * Greedy strategy: try preferredFreezerId first, then the freezer with the most remaining capacity.
 * @param {Array<object>} workingFreezers
 * @param {object} itemWithVolume
 * @returns {object|null}
 */
function pickTargetFreezer(workingFreezers, itemWithVolume) {
  const { preferredFreezerId, requiredLiters } = itemWithVolume;
  const candidates = workingFreezers.filter(
    (f) => f.remainingLiters >= requiredLiters,
  );
  if (!candidates.length) return null;

  if (preferredFreezerId) {
    const preferred = candidates.find((f) => f.freezer.freezerId === preferredFreezerId);
    if (preferred) return preferred;
  }

  // Fallback: freezer with the most remaining capacity
  return candidates.reduce((best, f) =>
    !best || f.remainingLiters > best.remainingLiters ? f : best,
  );
}

/**
 * Pick a zone within a freezer for the given item.
 * - Respects item.preferredZoneId.
 * - Falls back to first defined zone, or a synthetic "MAIN" zone when none are configured.
 * @param {Array<object>|undefined} freezerZones
 * @param {object} itemWithVolume
 * @returns {{zoneId: string, label: string}}
 */
function pickTargetZone(freezerZones, itemWithVolume) {
  const zones = Array.isArray(freezerZones) ? freezerZones : [];
  const { preferredZoneId } = itemWithVolume;

  if (zones.length > 0 && preferredZoneId) {
    const preferred = zones.find((z) => z.zoneId === preferredZoneId);
    if (preferred) {
      return { zoneId: preferred.zoneId, label: preferred.label || preferred.zoneId };
    }
  }

  if (zones.length > 0) {
    const first = zones[0];
    return { zoneId: first.zoneId, label: first.label || first.zoneId };
  }

  return { zoneId: "MAIN", label: "Main Compartment" };
}

/**
 * Pure core calculation for freezer space usage and layout.
 *
 * @param {FreezerSpaceCalculatorSchema["properties"]["inputs"]["properties"] & { [key: string]: any }} inputs
 * @returns {FreezerSpaceCalculatorSchema["properties"]["outputs"]["properties"] & { [key: string]: any }}
 */
function computeFreezerSpaceCore(inputs) {
  const {
    freezers = [],
    items = [],
    constraints = {},
  } = inputs || {};

  const globalReservePct =
    typeof constraints?.reservePct === "number" ? constraints.reservePct : undefined;

  /** workingFreezers = array of {
   *  freezer,
   *  remainingLiters,
   *  effectiveCapacity,
   *  reservedLiters
   * }
   */
  const workingFreezers = freezers.map((freezer) => {
    const { effectiveCapacity, reservedLiters, reservePct } = computeEffectiveCapacity(
      freezer,
      globalReservePct,
    );
    return {
      freezer,
      effectiveCapacity,
      reservedLiters,
      remainingLiters: effectiveCapacity,
      reservePct,
    };
  });

  // Map of freezerId -> usage
  const usageByFreezerId = new Map();
  workingFreezers.forEach(({ freezer, effectiveCapacity, reservedLiters }) => {
    usageByFreezerId.set(freezer.freezerId, {
      freezerId: freezer.freezerId,
      label: freezer.label || freezer.freezerId,
      capacityLiters: typeof freezer.capacityLiters === "number" ? freezer.capacityLiters : 0,
      usedLiters: 0,
      reservedLiters,
      freeLiters: effectiveCapacity,
      utilizationPct: 0,
    });
  });

  // Map of freezerId -> { zones: Map<zoneId, { zoneId, label, items: [] }> }
  const layoutByFreezerId = new Map();

  // Build list of items augmented with requiredLiters
  const itemsWithVolume = items.map((item) => {
    const vol = typeof item.volumeLiters === "number" ? item.volumeLiters : 0;
    const qty = typeof item.quantity === "number" ? item.quantity : 0;
    const requiredLiters = Math.max(vol * qty, 0);

    return {
      ...item,
      requiredLiters,
    };
  });

  // Sort items by descending volume requirement (simple first-fit decreasing)
  itemsWithVolume.sort((a, b) => b.requiredLiters - a.requiredLiters);

  /** @type {Array<object>} */
  const overflowItems = [];

  for (const item of itemsWithVolume) {
    if (item.requiredLiters <= 0) continue;

    const target = pickTargetFreezer(workingFreezers, item);
    if (!target) {
      overflowItems.push({
        itemId: item.itemId,
        label: item.label,
        requiredLiters: item.requiredLiters,
      });
      continue;
    }

    // Update working freezer remaining capacity
    target.remainingLiters = Math.max(
      target.remainingLiters - item.requiredLiters,
      0,
    );

    // Update usage record
    const usage = usageByFreezerId.get(target.freezer.freezerId);
    if (usage) {
      usage.usedLiters += item.requiredLiters;
      usage.freeLiters = Math.max(
        usage.capacityLiters - usage.usedLiters - usage.reservedLiters,
        0,
      );
      usage.utilizationPct =
        usage.capacityLiters > 0
          ? (usage.usedLiters / usage.capacityLiters) * 100
          : 0;
    }

    // Update layout
    let layout = layoutByFreezerId.get(target.freezer.freezerId);
    if (!layout) {
      layout = { freezerId: target.freezer.freezerId, zones: new Map() };
      layoutByFreezerId.set(target.freezer.freezerId, layout);
    }

    const chosenZone = pickTargetZone(target.freezer.zones, item);
    let zone = layout.zones.get(chosenZone.zoneId);
    if (!zone) {
      zone = {
        zoneId: chosenZone.zoneId,
        label: chosenZone.label,
        items: [],
      };
      layout.zones.set(chosenZone.zoneId, zone);
    }

    zone.items.push({
      itemId: item.itemId,
      label: item.label,
      volumeLiters: item.volumeLiters,
      quantity: item.quantity,
    });
  }

  // Build warnings based on utilization / overflow
  /** @type {string[]} */
  const warnings = [];
  const usageArray = Array.from(usageByFreezerId.values());

  usageArray.forEach((u) => {
    if (u.utilizationPct > 95) {
      warnings.push(
        `${u.label} is above 95% capacity. Consider moving some items or planning a 'use-first' list.`,
      );
    } else if (u.utilizationPct > 90) {
      warnings.push(
        `${u.label} is above 90% capacity. Monitor defrost cycles and organization.`,
      );
    }
  });

  if (overflowItems.length > 0) {
    warnings.push(
      "Some items could not be placed within the current freezer capacities. Plan a repack session or additional storage.",
    );
  }

  /** @type {{fitsAll: boolean, overflowItems: Array<object>, warnings: string[]}} */
  const fitReport = {
    fitsAll: overflowItems.length === 0,
    overflowItems,
    warnings,
  };

  // Build suggested layout array
  const suggestedLayout = Array.from(layoutByFreezerId.values()).map((layout) => ({
    freezerId: layout.freezerId,
    zones: Array.from(layout.zones.values()),
  }));

  // Session suggestions
  /** @type {Array<object>} */
  const sessionSuggestions = [];

  if (overflowItems.length > 0) {
    sessionSuggestions.push({
      id: `freezer_repack_${Date.now()}`,
      kind: "repack",
      label: "Repack & reorganize freezer to make planned batches fit",
      scheduledAt: null,
      metadata: {
        overflowCount: overflowItems.length,
        overflowItems,
      },
    });
  }

  const highUtilizationFreezers = usageArray.filter((u) => u.utilizationPct > 90);
  if (highUtilizationFreezers.length > 0) {
    sessionSuggestions.push({
      id: `freezer_pre_batch_${Date.now()}`,
      kind: "pre_batch",
      label: "Prepare freezer for incoming batches",
      scheduledAt: null,
      metadata: {
        freezerIds: highUtilizationFreezers.map((u) => u.freezerId),
      },
    });
  }

  // Inventory hints
  /** @type {Array<object>} */
  const inventoryHints = [];

  usageArray.forEach((u) => {
    inventoryHints.push({
      id: `capacity_guardrail_${u.freezerId}`,
      kind: "capacity_guardrail",
      freezerId: u.freezerId,
      zoneId: null,
      notes: `Current utilization is ${u.utilizationPct.toFixed(
        1,
      )}%. Try to keep this freezer below 90% where possible.`,
      payload: {
        utilizationPct: u.utilizationPct,
        capacityLiters: u.capacityLiters,
        usedLiters: u.usedLiters,
        freeLiters: u.freeLiters,
        reservedLiters: u.reservedLiters,
      },
    });
  });

  return {
    volumeUsage: usageArray,
    fitReport,
    suggestedLayout,
    sessionSuggestions,
    inventoryHints,
  };
}

/**
 * Public shim entry-point.
 *
 * Usage (direct):
 *   const result = await runFreezerSpaceCalculation(payload);
 *
 * Usage (event-driven):
 *   This can be called from an event listener when
 *   `calculator.freezerSpace.requested` is observed.
 *
 * @param {object} requestPayload - Full payload matching FreezerSpaceCalculator.schema.json
 * @returns {Promise<{inputs: any, outputs: any, meta: any, ok: boolean, error?: any}>}
 */
export async function runFreezerSpaceCalculation(requestPayload) {
  const payload = requestPayload || {};
  const inputs = payload.inputs || {};
  const meta = payload.meta || {};

  // Basic defensive checks
  if (!Array.isArray(inputs.freezers) || inputs.freezers.length === 0) {
    const error = {
      code: "NO_FREEZERS_DEFINED",
      message: "FreezerSpaceCalculator requires at least one freezer in inputs.freezers.",
    };
    emitEvent("calculator.freezerSpace.error", { payload, error });
    return { inputs, outputs: null, meta, ok: false, error };
  }

  if (!Array.isArray(inputs.items) || inputs.items.length === 0) {
    const error = {
      code: "NO_ITEMS_DEFINED",
      message: "FreezerSpaceCalculator requires at least one item in inputs.items.",
    };
    emitEvent("calculator.freezerSpace.error", { payload, error });
    return { inputs, outputs: null, meta, ok: false, error };
  }

  const outputs = computeFreezerSpaceCore(inputs);

  const resultEnvelope = {
    inputs,
    outputs,
    meta,
    ok: true,
  };

  // Emit calculator + storehouse events
  emitEvent("calculator.freezerSpace.completed", resultEnvelope);
  emitEvent("storehouse.freezer.capacity.updated", {
    householdId: inputs.householdId || null,
    volumeUsage: outputs.volumeUsage,
  });
  emitEvent("storehouse.freezer.layout.suggested", {
    householdId: inputs.householdId || null,
    suggestedLayout: outputs.suggestedLayout,
  });
  emitEvent("storehouse.inventory.location.hints.updated", {
    householdId: inputs.householdId || null,
    inventoryHints: outputs.inventoryHints,
  });

  if (Array.isArray(outputs.sessionSuggestions) && outputs.sessionSuggestions.length > 0) {
    emitEvent("session.request.fromFreezerSpace", {
      calculatorId: "FreezerSpaceCalculator",
      suggestions: outputs.sessionSuggestions,
    });
  }

  emitEvent("planningGraph.node.FREEZER_SPACE_CALCULATOR.completed", {
    nodeKey: "PG_NODE_FREEZER_SPACE_CALCULATOR",
    calculatorId: "FreezerSpaceCalculator",
    inputs,
    outputs,
  });

  // Optional Hub export
  exportToHubIfEnabled(resultEnvelope);

  return resultEnvelope;
}

/**
 * Default export: convenient adapter if you prefer a generic `run` interface
 * from your calculator registry.
 */
export default {
  run: runFreezerSpaceCalculation,
};
