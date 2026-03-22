const receivedByPlannerHousehold = new Map();
let projectionReceivedClientTotal = 0;

function makeCounterKey(planner, householdId) {
  return `${String(planner || "unknown")}::${String(householdId || "default")}`;
}

export function recordProjectionReceivedClient({ planner, householdId } = {}) {
  const key = makeCounterKey(planner, householdId);
  const next = Number(receivedByPlannerHousehold.get(key) || 0) + 1;
  receivedByPlannerHousehold.set(key, next);
  projectionReceivedClientTotal += 1;
  return next;
}

export function getProjectionReceivedClientCounters() {
  return {
    projection_received_client: {
      total: projectionReceivedClientTotal,
      byPlannerHousehold: Object.fromEntries(receivedByPlannerHousehold.entries()),
    },
  };
}

export function resetProjectionReceivedClientCounters() {
  receivedByPlannerHousehold.clear();
  projectionReceivedClientTotal = 0;
}

export default {
  recordProjectionReceivedClient,
  getProjectionReceivedClientCounters,
  resetProjectionReceivedClientCounters,
};
