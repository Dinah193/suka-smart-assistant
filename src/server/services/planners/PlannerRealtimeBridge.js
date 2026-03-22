"use strict";

const emittedByPlannerHousehold = new Map();
let projectionEmittedTotal = 0;

function makeCounterKey(planner, householdId) {
  return `${String(planner || "unknown")}::${String(householdId || "default")}`;
}

function recordProjectionEmitted({ planner, householdId } = {}) {
  const key = makeCounterKey(planner, householdId);
  const next = Number(emittedByPlannerHousehold.get(key) || 0) + 1;
  emittedByPlannerHousehold.set(key, next);
  projectionEmittedTotal += 1;
  return next;
}

function getProjectionDeliveryCounters() {
  return {
    projection_emitted: {
      total: projectionEmittedTotal,
      byPlannerHousehold: Object.fromEntries(emittedByPlannerHousehold.entries()),
    },
  };
}

function resetProjectionDeliveryCounters() {
  emittedByPlannerHousehold.clear();
  projectionEmittedTotal = 0;
}

function buildProjectionRealtimeEnvelope({ eventType, contract }) {
  return {
    eventType: String(eventType || "planner.projection.updated"),
    planner: String(contract?.planner || "unknown"),
    householdId: String(contract?.householdId || "default-household"),
    updateType: String(contract?.updateType || "unknown"),
    contract,
    emittedAt: new Date().toISOString(),
  };
}

function bridgeProjectionRealtimeEvent({ eventType, contract, namespaceEmit, bridgeEmit } = {}) {
  const envelope = buildProjectionRealtimeEnvelope({ eventType, contract });
  const room = `home:${envelope.householdId}`;
  recordProjectionEmitted({ planner: envelope.planner, householdId: envelope.householdId });

  let emitNs = namespaceEmit;
  let emitBridge = bridgeEmit;
  if (typeof emitNs !== "function" || typeof emitBridge !== "function") {
    try {
      const socketMod = require("../../socket.js");
      emitNs = typeof emitNs === "function" ? emitNs : socketMod?.namespaceEmit;
      emitBridge =
        typeof emitBridge === "function"
          ? emitBridge
          : (evt) => socketMod?.EventBus?.emit?.("bridge:emit", evt);
    } catch {
      emitNs = emitNs || null;
      emitBridge = emitBridge || null;
    }
  }

  if (typeof emitNs === "function") {
    emitNs("/core", "planner:projection:update", envelope, room);
    emitNs("/core", eventType, envelope, room);
  }

  if (typeof emitBridge === "function") {
    emitBridge({ ns: "/core", event: "planner:projection:update", payload: envelope, room });
    emitBridge({ ns: "/core", event: eventType, payload: envelope, room });
  }

  return envelope;
}

module.exports = {
  buildProjectionRealtimeEnvelope,
  bridgeProjectionRealtimeEvent,
  getProjectionDeliveryCounters,
  resetProjectionDeliveryCounters,
};
