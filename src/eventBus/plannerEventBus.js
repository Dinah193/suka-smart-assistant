import EventEmitter from "eventemitter3";

const bus = new EventEmitter();

export const PlannerEvents = {
  MEAL_PLAN_UPDATED: "planner.mealPlan.updated",
  STOREHOUSE_INVENTORY_UPDATED: "planner.storehouse.inventory.updated",
  HOMESTEAD_PRODUCTION_UPDATED: "planner.homestead.production.updated",
  PRESERVATION_TASK_CREATED: "planner.preservation.task.created",
  PRESERVATION_TASK_COMPLETED: "planner.preservation.task.completed",
  PLANNER_RECOMMENDATIONS_UPDATED: "planner.recommendations.updated",
  PLANNER_SYNC_REQUESTED: "planner.sync.requested",
};

export function publishPlannerEvent(type, payload = {}, meta = {}) {
  const envelope = {
    type,
    ts: new Date().toISOString(),
    source: meta.source || "plannerEventBus",
    correlationId: meta.correlationId || null,
    data: payload,
  };
  bus.emit(type, envelope);
  bus.emit("planner.*", envelope);
  return envelope;
}

export function subscribePlannerEvent(type, handler) {
  bus.on(type, handler);
  return () => bus.off(type, handler);
}

export function subscribeAllPlannerEvents(handler) {
  bus.on("planner.*", handler);
  return () => bus.off("planner.*", handler);
}

export default {
  PlannerEvents,
  publishPlannerEvent,
  subscribePlannerEvent,
  subscribeAllPlannerEvents,
};
