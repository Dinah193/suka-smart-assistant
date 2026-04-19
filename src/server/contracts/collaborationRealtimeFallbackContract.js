"use strict";

function normalizeRealtimeState(state = {}) {
  return {
    transport: String(state.transport || "websocket").toLowerCase(),
    fallbackReason: state.fallbackReason ? String(state.fallbackReason) : null,
    lastSequence: Number.isFinite(Number(state.lastSequence)) ? Number(state.lastSequence) : 0,
    missedEvents: Array.isArray(state.missedEvents) ? state.missedEvents : [],
  };
}

function resolveRealtimeFallback({ state = {}, disconnected = false, reason = null } = {}) {
  const current = normalizeRealtimeState(state);
  if (!disconnected) {
    return {
      ...current,
      transport: current.transport,
      fallbackReason: null,
    };
  }

  return {
    ...current,
    transport: "polling",
    fallbackReason: String(reason || "connection_lost"),
  };
}

function buildReplayPayload({ state = {}, polledEvents = [] } = {}) {
  const current = normalizeRealtimeState(state);
  const replayEvents = polledEvents
    .filter((event) => Number(event?.sequence || 0) > current.lastSequence)
    .sort((a, b) => Number(a.sequence || 0) - Number(b.sequence || 0));

  const lastSequence = replayEvents.length
    ? Number(replayEvents[replayEvents.length - 1].sequence || current.lastSequence)
    : current.lastSequence;

  return {
    transport: current.transport,
    fallbackReason: current.fallbackReason,
    replayEvents,
    lastSequence,
  };
}

module.exports = {
  normalizeRealtimeState,
  resolveRealtimeFallback,
  buildReplayPayload,
};
