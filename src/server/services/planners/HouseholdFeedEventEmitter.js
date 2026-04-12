"use strict";

function toTrimmedString(value) {
  return String(value || "").trim();
}

function toFiniteNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeMutationType(value) {
  const key = toTrimmedString(value).toLowerCase();
  if (!key) return "mutation";
  return key;
}

function buildUnifiedFeedMutationEvent({
  householdId,
  moduleKey,
  sourceId,
  mutationType,
  action,
  delta = 0,
  actor,
  at,
  detail = "",
  metadata = {},
  updatedItem = null,
}) {
  const when = toTrimmedString(at) || new Date().toISOString();
  const eventModule = toTrimmedString(moduleKey).toLowerCase() || "community";
  const eventSourceId = toTrimmedString(sourceId);
  const eventAction = toTrimmedString(action).toLowerCase();
  const kind = normalizeMutationType(mutationType);

  return {
    id: `feed-event:${eventModule}:${eventSourceId}:${when}:${kind}`,
    householdId: toTrimmedString(householdId) || "default-household",
    sourceModule: eventModule,
    sourceId: eventSourceId,
    mutationType: kind,
    action: eventAction || null,
    delta: toFiniteNumber(delta, 0),
    actor: toTrimmedString(actor) || "unknown",
    detail: toTrimmedString(detail),
    metadata: metadata && typeof metadata === "object" ? metadata : {},
    at: when,
    snapshot: updatedItem && typeof updatedItem === "object"
      ? {
          id: toTrimmedString(updatedItem.id),
          stats: updatedItem.stats && typeof updatedItem.stats === "object" ? updatedItem.stats : {},
          lastAction: updatedItem.lastAction || null,
          lastActionAt: updatedItem.lastActionAt || null,
        }
      : null,
  };
}

function buildUnifiedFeedMutationResponse({
  householdId,
  moduleKey,
  updatedItem,
  event,
  extra = {},
}) {
  return {
    ok: true,
    householdId: toTrimmedString(householdId) || "default-household",
    module: toTrimmedString(moduleKey).toLowerCase() || "community",
    updatedItem,
    event,
    ...extra,
  };
}

module.exports = {
  buildUnifiedFeedMutationEvent,
  buildUnifiedFeedMutationResponse,
};
