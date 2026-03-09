// C:\Users\larho\suka-smart-assistant\src\events\eventMappers.js
// -----------------------------------------------------------------------------
// PURPOSE
// -----------------------------------------------------------------------------
// This file is the translation layer between **SSA internal events** and the
// **Hub-facing** record format when familyFundMode=true.
//
// SSA pipeline (high-level):
// 1. imports →
// 2. normalized →
// 3. intelligence created →
// 4. domain engines generate actionable sessions (meals, cleaning, garden, animal, preservation) →
// 5. domain engines EMIT events (inventory.updated, garden.harvest.logged, etc.) →
// 6. if familyFundMode=true → map SSA event → Hub-compatible packet → send to Hub
//
// This file ONLY does step 6: mapping + optional delivery.
// It subscribes to the shared eventBus and watches for hub-eligible events.
// If Hub is unavailable, it fails silently (per your rule).
//
// ASSUMPTIONS (as requested):
// - src/services/events/eventBus.js exists and exposes: on(eventName, handler) and emit(envelope)
// - src/config/featureFlags.json exists and can be imported
// - src/services/hub/HubPacketFormatter.js exists and exports { formatForHub }
// - src/services/hub/FamilyFundConnector.js exists and exports { sendToHub }
//
// Forward-thinking / extensible:
// - new SSA domains/events can register their own mapper at runtime via registerEventMapper(type, fn)
// - each mapper receives the full SSA envelope { type, ts, source, data } and must return { hubType, payload, meta }
// - we keep a single initHubEventBridge() to be called ONCE at app boot (e.g. in main.jsx or App.jsx)
// -----------------------------------------------------------------------------

import eventBus from "../services/events/eventBus.js";
import featureFlags from "@/config/featureFlags.json" assert { type: "json" };

// We will try to import Hub helpers, but we must not crash SSA if they aren't present.
// This keeps SSA independent from the Hub.
let HubPacketFormatter = null;
let FamilyFundConnector = null;

(async function softImportHubDeps() {
  try {
    // These paths are assumptions based on your project structure.
    // Adjust if yours are slightly different.
    const fmtMod = await import("@/services/hub/HubPacketFormatter.js");
    const connMod = await import("@/services/hub/FamilyFundConnector.js");
    HubPacketFormatter = fmtMod?.default || fmtMod;
    FamilyFundConnector = connMod?.default || connMod;
  } catch (err) {
    // Silent by design — SSA must run even if Hub layer is not present.
    // console.warn("[eventMappers] Hub helpers not available — running in SSA-only mode.");
  }
})();

/**
 * In-memory registry of event → mapper.
 * Keys: SSA event types (e.g. "inventory.updated")
 * Values: (ssaEventEnvelope) => HubPacket | null
 *
 * HubPacket shape (logical):
 * {
 *    hubType: string,                 // e.g. "inventory.update", "garden.harvest"
 *    payload: object,                 // all the data to send
 *    meta: { source, ts, domain }     // any extras
 * }
 */
const EVENT_MAPPERS = Object.create(null);

// -----------------------------------------------------------------------------
// DEFAULT MAPPERS
// These are derived from your eventCatalog.json
// -----------------------------------------------------------------------------

/**
 * inventory.updated → hub:inventory.update
 */
function mapInventoryUpdated(ssaEvt) {
  const d = ssaEvt?.data;
  if (!d || !d.itemId) return null;

  return {
    hubType: "inventory.update",
    payload: {
      itemId: d.itemId,
      changeType: d.changeType || "unknown",
      delta: d.delta ?? null,
      after: d.after ?? null,
      reason: d.reason || "unspecified",
    },
    meta: {
      ts: ssaEvt.ts,
      source: ssaEvt.source,
      domain: "inventory",
    },
  };
}

/**
 * inventory.shortage.detected → hub:inventory.shortage
 */
function mapInventoryShortage(ssaEvt) {
  const d = ssaEvt?.data;
  if (!d || !d.itemId) return null;

  return {
    hubType: "inventory.shortage",
    payload: {
      itemId: d.itemId,
      itemName: d.itemName,
      currentQty: d.currentQty,
      requiredQty: d.requiredQty,
      suggestedRoutes: d.suggestedRoutes || [],
    },
    meta: {
      ts: ssaEvt.ts,
      source: ssaEvt.source,
      domain: "inventory",
    },
  };
}

/**
 * meal.session.generated → hub:meal.session
 */
function mapMealSessionGenerated(ssaEvt) {
  const d = ssaEvt?.data;
  if (!d || !d.sessionId) return null;

  return {
    hubType: "meal.session",
    payload: {
      sessionId: d.sessionId,
      sourceImportId: d.sourceImportId || null,
      recipes: d.recipes || [],
      inventoryLinks: d.inventoryLinks || [],
      schedule: d.schedule || null,
    },
    meta: {
      ts: ssaEvt.ts,
      source: ssaEvt.source,
      domain: "meals",
    },
  };
}

/**
 * meal.executed → hub:meal.executed
 */
function mapMealExecuted(ssaEvt) {
  const d = ssaEvt?.data;
  if (!d || !d.sessionId) return null;

  return {
    hubType: "meal.executed",
    payload: {
      sessionId: d.sessionId,
      recipes: d.recipes || [],
      inventoryDeltas: d.inventoryDeltas || [],
      notes: d.notes || null,
    },
    meta: {
      ts: ssaEvt.ts,
      source: ssaEvt.source,
      domain: "meals",
    },
  };
}

/**
 * cleaning.session.generated → hub:cleaning.session
 */
function mapCleaningSessionGenerated(ssaEvt) {
  const d = ssaEvt?.data;
  if (!d || !d.sessionId) return null;

  return {
    hubType: "cleaning.session",
    payload: {
      sessionId: d.sessionId,
      zones: d.zones || [],
      tasks: d.tasks || [],
      estimatedDurationMin: d.estimatedDurationMin || null,
      sourceImportId: d.sourceImportId || null,
    },
    meta: {
      ts: ssaEvt.ts,
      source: ssaEvt.source,
      domain: "cleaning",
    },
  };
}

/**
 * cleaning.executed → hub:cleaning.executed
 */
function mapCleaningExecuted(ssaEvt) {
  const d = ssaEvt?.data;
  if (!d || !d.sessionId) return null;

  return {
    hubType: "cleaning.executed",
    payload: {
      sessionId: d.sessionId,
      zones: d.zones || [],
      completedTasks: d.completedTasks || [],
      durationMin: d.durationMin || null,
    },
    meta: {
      ts: ssaEvt.ts,
      source: ssaEvt.source,
      domain: "cleaning",
    },
  };
}

/**
 * garden.plan.generated → hub:garden.plan
 */
function mapGardenPlanGenerated(ssaEvt) {
  const d = ssaEvt?.data;
  if (!d || !d.planId) return null;

  return {
    hubType: "garden.plan",
    payload: {
      planId: d.planId,
      sourceImportId: d.sourceImportId || null,
      crops: d.crops || [],
      tasks: d.tasks || [],
      schedule: d.schedule || null,
    },
    meta: {
      ts: ssaEvt.ts,
      source: ssaEvt.source,
      domain: "garden",
    },
  };
}

/**
 * garden.harvest.logged → hub:garden.harvest
 */
function mapGardenHarvestLogged(ssaEvt) {
  const d = ssaEvt?.data;
  if (!d || !d.harvestId) return null;

  return {
    hubType: "garden.harvest",
    payload: {
      harvestId: d.harvestId,
      crop: d.crop,
      quantity: d.quantity,
      unit: d.unit,
      inventoryItemId: d.inventoryItemId || null,
      preservationSuggested: !!d.preservationSuggested,
    },
    meta: {
      ts: ssaEvt.ts,
      source: ssaEvt.source,
      domain: "garden",
    },
  };
}

/**
 * animal.plan.generated → hub:animal.plan
 */
function mapAnimalPlanGenerated(ssaEvt) {
  const d = ssaEvt?.data;
  if (!d || !d.planId) return null;

  return {
    hubType: "animal.plan",
    payload: {
      planId: d.planId,
      sourceImportId: d.sourceImportId || null,
      species: d.species || null,
      actions: d.actions || [],
      schedule: d.schedule || null,
    },
    meta: {
      ts: ssaEvt.ts,
      source: ssaEvt.source,
      domain: "animals",
    },
  };
}

/**
 * animal.butchery.logged → hub:animal.butchery
 * This is important for your “blood meal” and multi-product butchery flows.
 */
function mapAnimalButcheryLogged(ssaEvt) {
  const d = ssaEvt?.data;
  if (!d || !d.butcheryId) return null;

  return {
    hubType: "animal.butchery",
    payload: {
      butcheryId: d.butcheryId,
      species: d.species || null,
      yieldCurveId: d.yieldCurveId || null,
      cuts: d.cuts || [],
      inventoryUpdates: d.inventoryUpdates || [],
      byproducts: d.byproducts || [],
      notes: d.notes || null,
    },
    meta: {
      ts: ssaEvt.ts,
      source: ssaEvt.source,
      domain: "animals",
    },
  };
}

/**
 * preservation.completed → hub:preservation.session
 */
function mapPreservationCompleted(ssaEvt) {
  const d = ssaEvt?.data;
  if (!d || !d.sessionId) return null;

  return {
    hubType: "preservation.session",
    payload: {
      sessionId: d.sessionId,
      method: d.method,
      inputs: d.inputs || [],
      outputs: d.outputs || [],
      notes: d.notes || null,
    },
    meta: {
      ts: ssaEvt.ts,
      source: ssaEvt.source,
      domain: "preservation",
    },
  };
}

// Register default mappers
EVENT_MAPPERS["inventory.updated"] = mapInventoryUpdated;
EVENT_MAPPERS["inventory.shortage.detected"] = mapInventoryShortage;
EVENT_MAPPERS["meal.session.generated"] = mapMealSessionGenerated;
EVENT_MAPPERS["meal.executed"] = mapMealExecuted;
EVENT_MAPPERS["cleaning.session.generated"] = mapCleaningSessionGenerated;
EVENT_MAPPERS["cleaning.executed"] = mapCleaningExecuted;
EVENT_MAPPERS["garden.plan.generated"] = mapGardenPlanGenerated;
EVENT_MAPPERS["garden.harvest.logged"] = mapGardenHarvestLogged;
EVENT_MAPPERS["animal.plan.generated"] = mapAnimalPlanGenerated;
EVENT_MAPPERS["animal.butchery.logged"] = mapAnimalButcheryLogged;
EVENT_MAPPERS["preservation.completed"] = mapPreservationCompleted;

// -----------------------------------------------------------------------------
// CORE HELPERS
// -----------------------------------------------------------------------------

/**
 * Get the mapper function for a given SSA event type.
 * @param {string} eventType
 * @returns {function|null}
 */
export function getEventMapper(eventType) {
  return EVENT_MAPPERS[eventType] || null;
}

/**
 * Register/override a mapper for a given event type.
 * This allows new domains (e.g. `storehouse.*`, `health.*`, `education.*`)
 * to plug in without touching this core file.
 * @param {string} eventType
 * @param {(evt: object) => object|null} mapperFn
 */
export function registerEventMapper(eventType, mapperFn) {
  if (typeof eventType !== "string" || !eventType) return;
  if (typeof mapperFn !== "function") return;
  EVENT_MAPPERS[eventType] = mapperFn;
}

/**
 * Map a SSA event envelope to a Hub-ready packet.
 * Returns null if:
 *  - no mapper exists
 *  - mapper decides it's not hub-worthy
 *  - envelope is invalid
 *
 * @param {object} ssaEventEnvelope
 * @returns {object|null}
 */
export function mapEventToHubRecord(ssaEventEnvelope) {
  if (!ssaEventEnvelope || typeof ssaEventEnvelope !== "object") return null;
  const { type } = ssaEventEnvelope;
  if (!type) return null;

  const mapper = getEventMapper(type);
  if (!mapper) return null;

  try {
    return mapper(ssaEventEnvelope);
  } catch (err) {
    // Mapping error should NOT crash the app
    // console.error("[eventMappers] failed to map event", type, err);
    return null;
  }
}

/**
 * Export a hub packet IF familyFundMode is ON and Hub deps are available.
 * Fails silently per your requirement.
 * @param {object} ssaEventEnvelope
 */
async function exportToHubIfEnabled(ssaEventEnvelope) {
  const familyFundMode = !!featureFlags?.familyFundMode;
  if (!familyFundMode) return;

  const hubPacket = mapEventToHubRecord(ssaEventEnvelope);
  if (!hubPacket) return;

  try {
    // Optional formatting step – if the Hub has its own strict schema
    const finalPacket = HubPacketFormatter?.formatForHub
      ? HubPacketFormatter.formatForHub(hubPacket)
      : hubPacket;

    if (FamilyFundConnector?.sendToHub) {
      await FamilyFundConnector.sendToHub(finalPacket);
      // Also emit local telemetry for UI dashboards, if you want.
      eventBus.emit({
        type: "hub.export.succeeded",
        ts: new Date().toISOString(),
        source: "events/eventMappers",
        data: {
          exportId:
            finalPacket?.payload?.sessionId ||
            finalPacket?.payload?.itemId ||
            cryptoRandomId(),
          responseMeta: { mode: "familyFund" },
        },
      });
    }
  } catch (err) {
    // Silent — but we can emit local telemetry
    eventBus.emit({
      type: "hub.export.failed",
      ts: new Date().toISOString(),
      source: "events/eventMappers",
      data: {
        exportId: cryptoRandomId(),
        reason: err?.message || "unknown",
        attempts: 1,
      },
    });
  }
}

/**
 * Small helper to generate a fallback id for telemetry.
 * We don't want to import a heavy uuid lib here.
 */
function cryptoRandomId() {
  // Not cryptographically perfect in all envs, but good enough for IDs.
  return "exp_" + Math.random().toString(36).slice(2, 10);
}

// -----------------------------------------------------------------------------
// BRIDGE INITIALIZER
// -----------------------------------------------------------------------------

/**
 * Call this ONCE at app boot to start listening for SSA events that should go to Hub.
 *
 * This subscribes to **all** events on eventBus and forwards only the ones
 * that have a registered mapper *and* familyFundMode=true.
 *
 * Example usage:
 *   import { initHubEventBridge } from "./src/events/eventMappers.js";
 *   initHubEventBridge();
 */
export function initHubEventBridge() {
  // We subscribe to ALL events once, and decide in-handler if we should map+export.
  eventBus.on("*", async (ssaEventEnvelope) => {
    // Defensive: some eventBus implementations might pass (type, data) instead of one envelope.
    const evt =
      typeof ssaEventEnvelope === "object" && ssaEventEnvelope?.type
        ? ssaEventEnvelope
        : null;

    if (!evt) return;

    // If there is no mapper registered for this type, skip quickly.
    if (!EVENT_MAPPERS[evt.type]) return;

    // Perform export if needed
    await exportToHubIfEnabled(evt);
  });
}

// -----------------------------------------------------------------------------
// Extra: manual export function for modules that want to push a specific event
// without waiting for the global bridge (e.g. right after they emit).
// -----------------------------------------------------------------------------

/**
 * Modules that change household data can do:
 *   eventBus.emit(ev);
 *   forwardEventToHub(ev);
 *
 * This mirrors your “also call a small helper like exportToHubIfEnabled(payload)”.
 *
 * @param {object} ssaEventEnvelope
 * @returns {Promise<void>}
 */
export async function forwardEventToHub(ssaEventEnvelope) {
  await exportToHubIfEnabled(ssaEventEnvelope);
}
