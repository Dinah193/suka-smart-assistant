// C:\Users\larho\suka-smart-assistant\src\features\calculators\storehouseMeals\FreezerSpaceCalculator\FreezerSpaceCalculator.hooks.js

/**
 * FreezerSpaceCalculator.hooks
 *
 * How this fits:
 * - Listens for `calculator.freezerSpace.completed` events emitted when the
 *   FreezerSpaceCalculator shim finishes a computation.
 * - Translates calculator outputs into:
 *     • storehouse / inventory events (capacity & layout updates)
 *     • preservation & batch-cooking session requests
 *     • optional Hub export envelopes when familyFundMode is enabled
 * - Designed to be wired into a central hooks/graph orchestrator which passes
 *   an `on(type, handler)` subscription function.
 *
 * This file does NOT:
 * - Perform the calculation itself (that lives in the shim).
 * - Implement the SessionRunner UI (mounted globally in App.jsx).
 */

import { emit as emitRaw } from "@/services/eventBus";
import { familyFundMode as familyFundModeFlag } from "@/services/featureFlags";
import { HubPacketFormatter, FamilyFundConnector } from "@/services/hub";

/** Canonical source string for events emitted from these hooks */
const HOOK_SOURCE = "features/FreezerSpaceCalculator.hooks";

/**
 * Get current ISO timestamp
 * @returns {string}
 */
function nowIso() {
  return new Date().toISOString();
}

/**
 * Safe wrapper around eventBus.emit using the standard envelope shape.
 * @param {string} type
 * @param {any} data
 */
function emitEvent(type, data) {
  try {
    emitRaw({
      type,
      ts: nowIso(),
      source: HOOK_SOURCE,
      data,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[FreezerSpaceCalculator.hooks] emit error:", type, err);
  }
}

/**
 * Build inventory capacity events from calculator output.
 *
 * @param {object} payload
 * @param {object} payload.inputs  - calculator inputs
 * @param {object} payload.outputs - calculator outputs
 * @returns {Array<object>} inventoryEvents - ready-to-emit event data payloads
 */
function buildInventoryCapacityEvents({ inputs, outputs }) {
  const result = [];

  if (!outputs || !Array.isArray(outputs.volumeUsage)) {
    return result;
  }

  const householdId = inputs?.householdId ?? null;

  for (const u of outputs.volumeUsage) {
    if (!u || typeof u !== "object") continue;

    const {
      freezerId,
      label,
      capacityLiters,
      usedLiters,
      freeLiters,
      utilizationPct,
      reservePctEffective,
    } = u;

    if (!freezerId || typeof capacityLiters !== "number") continue;

    result.push({
      householdId,
      freezerId,
      label: label || freezerId,
      capacityLiters,
      usedLiters: typeof usedLiters === "number" ? usedLiters : null,
      freeLiters: typeof freeLiters === "number" ? freeLiters : null,
      utilizationPct:
        typeof utilizationPct === "number" ? utilizationPct : null,
      reservePct: typeof reservePctEffective === "number"
        ? reservePctEffective
        : null,
      ts: nowIso(),
      source: HOOK_SOURCE,
    });
  }

  return result;
}

/**
 * Build inventory layout events (zones & assignments) from calculator output.
 *
 * @param {object} payload
 * @param {object} payload.inputs
 * @param {object} payload.outputs
 * @returns {Array<object>}
 */
function buildInventoryLayoutEvents({ inputs, outputs }) {
  const result = [];

  if (!outputs || !Array.isArray(outputs.suggestedLayout)) {
    return result;
  }

  const householdId = inputs?.householdId ?? null;

  for (const layout of outputs.suggestedLayout) {
    if (!layout || typeof layout !== "object") continue;

    const { freezerId, zones } = layout;
    if (!freezerId || !Array.isArray(zones)) continue;

    const normalizedZones = zones.map((z) => ({
      zoneId: z?.zoneId ?? null,
      label: z?.label ?? null,
      items: Array.isArray(z?.items)
        ? z.items.map((it) => ({
            itemId: it?.itemId ?? null,
            label: it?.label ?? null,
            quantity:
              typeof it?.quantity === "number" ? it.quantity : undefined,
            volumeLiters:
              typeof it?.volumeLiters === "number" ? it.volumeLiters : undefined,
          }))
        : [],
    }));

    result.push({
      householdId,
      freezerId,
      zones: normalizedZones,
      ts: nowIso(),
      source: HOOK_SOURCE,
    });
  }

  return result;
}

/**
 * Build batch / preservation session requests if there is overflow or
 * special layout suggestions.
 *
 * @param {object} payload
 * @param {object} payload.inputs
 * @param {object} payload.outputs
 * @returns {{ sessions: Array<object> }}
 */
function buildSessionRequests({ inputs, outputs }) {
  const sessions = [];

  const householdId = inputs?.householdId ?? null;
  const fitReport = outputs?.fitReport || {};
  const suggestions = Array.isArray(outputs?.sessionSuggestions)
    ? outputs.sessionSuggestions
    : [];

  // From explicit session suggestions (shim-provided hints)
  for (const s of suggestions) {
    if (!s || typeof s !== "object") continue;

    sessions.push({
      kind: s.kind || "freezer-reorg",
      label:
        s.label ||
        "Plan freezer reorganization and batch cooking around capacity limits",
      domain: "storehouse",
      householdId,
      calculatorId: "FreezerSpaceCalculator",
      steps: Array.isArray(s.steps) ? s.steps : [],
      meta: {
        from: "FreezerSpaceCalculator",
        suggestionId: s.id || null,
      },
    });
  }

  // If overflow items exist, propose a batch-cooking/preservation session
  if (fitReport && Array.isArray(fitReport.overflowItems) &&
      fitReport.overflowItems.length > 0) {
    sessions.push({
      kind: "batch-cook-overflow",
      label: "Batch cook / preserve overflow items",
      domain: "cooking",
      householdId,
      calculatorId: "FreezerSpaceCalculator",
      overflowItems: fitReport.overflowItems.map((o) => ({
        itemId: o?.itemId ?? null,
        label: o?.label ?? null,
        requiredLiters:
          typeof o?.requiredLiters === "number" ? o.requiredLiters : null,
      })),
      meta: {
        from: "FreezerSpaceCalculator",
      },
    });
  }

  return { sessions };
}

/**
 * Optionally format and export a summary to the Hub if familyFundMode is on.
 *
 * @param {object} calcResult - The calculator result payload
 */
async function exportToHubIfEnabled(calcResult) {
  try {
    const familyFundMode =
      typeof familyFundModeFlag === "boolean"
        ? familyFundModeFlag
        : !!familyFundModeFlag;

    if (!familyFundMode) return;

    const packet = HubPacketFormatter?.format
      ? HubPacketFormatter.format({
          kind: "calculator",
          calculatorId: "FreezerSpaceCalculator",
          ts: nowIso(),
          payload: calcResult,
          source: HOOK_SOURCE,
        })
      : null;

    if (!packet) return;

    if (FamilyFundConnector?.send) {
      await FamilyFundConnector.send(packet);
      emitEvent("session.exported", {
        tool: "Hub",
        calculatorId: "FreezerSpaceCalculator",
        status: "success",
      });
    }
  } catch (err) {
    // Fail silently per contract, but log locally for debugging
    // eslint-disable-next-line no-console
    console.error(
      "[FreezerSpaceCalculator.hooks] Hub export failed (soft):",
      err,
    );
  }
}

/**
 * Main registration function.
 *
 * Call this from your PlanningGraph / hooks orchestrator with your eventBus
 * subscription function, e.g.:
 *
 *   import { on } from "@/services/eventBus";
 *   import { registerFreezerSpaceCalculatorHooks } from
 *     "@/features/calculators/storehouseMeals/FreezerSpaceCalculator/FreezerSpaceCalculator.hooks";
 *
 *   registerFreezerSpaceCalculatorHooks({ on });
 *
 * @param {object} deps
 * @param {(type: string, handler: (evt: any) => void) => void} deps.on
 */
export function registerFreezerSpaceCalculatorHooks({ on } = {}) {
  if (typeof on !== "function") {
    // eslint-disable-next-line no-console
    console.warn(
      "[FreezerSpaceCalculator.hooks] register called without a valid `on` function. Hooks not attached.",
    );
    return;
  }

  /**
   * Handle calculator completion → drive inventory + sessions.
   *
   * Expected event envelope:
   * {
   *   type: "calculator.freezerSpace.completed",
   *   ts: ISO,
   *   source: string,
   *   data: {
   *     inputs: { ... },
   *     outputs: { ... },
   *     ok: boolean,
   *     error?: { code, message }
   *   }
   * }
   */
  on("calculator.freezerSpace.completed", async (evt) => {
    const calc = evt?.data || evt?.result || evt;

    if (!calc || calc.ok === false) {
      if (calc?.error) {
        emitEvent("calculator.freezerSpace.error", {
          error: calc.error,
          originalEvent: evt,
        });
      }
      return;
    }

    const inputs = calc.inputs || {};
    const outputs = calc.outputs || {};

    // ---- 1. Inventory capacity updates ----
    const capacityEvents = buildInventoryCapacityEvents({ inputs, outputs });
    for (const payload of capacityEvents) {
      emitEvent("storehouse.freezer.capacity.upserted", payload);
    }

    // ---- 2. Inventory layout updates ----
    const layoutEvents = buildInventoryLayoutEvents({ inputs, outputs });
    for (const payload of layoutEvents) {
      emitEvent("storehouse.freezer.layout.updated", payload);
    }

    // ---- 3. Session suggestions (batch + preservation flows) ----
    const { sessions } = buildSessionRequests({ inputs, outputs });
    if (sessions.length > 0) {
      emitEvent("session.request.fromFreezerSpace.batch", {
        householdId: inputs?.householdId ?? null,
        calculatorId: "FreezerSpaceCalculator",
        sessions,
      });
    }

    // ---- 4. PlanningGraph marker ----
    emitEvent("planningGraph.node.FREEZER_SPACE_CALCULATOR.completed", {
      inputs,
      outputs,
      ts: nowIso(),
    });

    // ---- 5. Optional Hub export ----
    await exportToHubIfEnabled(calc);
  });

  /**
   * Optional: respond when a freezer-related session completes.
   * This can be extended later to trigger recalculation or inventory refresh.
   *
   * Expected event envelope:
   * {
   *   type: "session.completed",
   *   ts: ISO,
   *   source: string,
   *   data: {
   *     session: { id, domain, source, ... },
   *     analytics?: { ... }
   *   }
   * }
   */
  on("session.completed", (evt) => {
    const session = evt?.data?.session;
    if (!session || session.domain !== "storehouse") return;

    const isFreezerSession =
      session.source?.type === "manual" &&
      (session.source?.refId === "FreezerSpaceCalculator" ||
        session.metadata?.calculatorId === "FreezerSpaceCalculator");

    if (!isFreezerSession) return;

    emitEvent("storehouse.freezer.session.completed", {
      sessionId: session.id,
      domain: session.domain,
      calculatorId: "FreezerSpaceCalculator",
      analytics: evt?.data?.analytics || null,
    });

    // Extension point:
    // - you could trigger a recalculation here by emitting:
    //   "calculator.freezerSpace.recalculate.requested" with minimal inputs.
  });
}
