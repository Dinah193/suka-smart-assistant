import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  buildProjectionRealtimeEnvelope,
  bridgeProjectionRealtimeEvent,
  getProjectionDeliveryCounters,
  resetProjectionDeliveryCounters,
} = require("../src/server/services/planners/PlannerRealtimeBridge.js");

describe("PlannerProjectionSync realtime bridge", () => {
  beforeEach(() => {
    resetProjectionDeliveryCounters();
  });

  it("builds a projection realtime envelope", () => {
    const envelope = buildProjectionRealtimeEnvelope({
      eventType: "planner.storehouse.inventory.updated",
      contract: {
        planner: "storehouse",
        householdId: "home-1",
        updateType: "inventory.upsert",
      },
    });

    expect(envelope.eventType).toBe("planner.storehouse.inventory.updated");
    expect(envelope.planner).toBe("storehouse");
    expect(envelope.householdId).toBe("home-1");
    expect(envelope.updateType).toBe("inventory.upsert");
    expect(envelope.emittedAt).toBeTruthy();
  });

  it("emits projection update through namespace and bridge channels", () => {
    const namespaceEmit = vi.fn();
    const bridgeEmit = vi.fn();

    const envelope = bridgeProjectionRealtimeEvent({
      eventType: "planner.homestead.production.updated",
      contract: {
        planner: "homestead",
        householdId: "home-77",
        updateType: "production.upsert",
      },
      namespaceEmit,
      bridgeEmit,
    });

    expect(namespaceEmit).toHaveBeenCalledTimes(2);
    expect(namespaceEmit).toHaveBeenNthCalledWith(
      1,
      "/core",
      "planner:projection:update",
      envelope,
      "home:home-77"
    );
    expect(namespaceEmit).toHaveBeenNthCalledWith(
      2,
      "/core",
      "planner.homestead.production.updated",
      envelope,
      "home:home-77"
    );

    expect(bridgeEmit).toHaveBeenCalledTimes(2);
    expect(bridgeEmit).toHaveBeenNthCalledWith(1, {
      ns: "/core",
      event: "planner:projection:update",
      payload: envelope,
      room: "home:home-77",
    });
    expect(bridgeEmit).toHaveBeenNthCalledWith(2, {
      ns: "/core",
      event: "planner.homestead.production.updated",
      payload: envelope,
      room: "home:home-77",
    });

    const counters = getProjectionDeliveryCounters();
    expect(counters.projection_emitted.total).toBe(1);
    expect(counters.projection_emitted.byPlannerHousehold["homestead::home-77"]).toBe(1);
  });

  it("supports backend meal fanout recommendation events", () => {
    const namespaceEmit = vi.fn();
    const bridgeEmit = vi.fn();

    const envelope = bridgeProjectionRealtimeEvent({
      eventType: "planner.recommendations.updated",
      contract: {
        planner: "meal",
        householdId: "home-pr1",
        updateType: "meal.fanout",
      },
      namespaceEmit,
      bridgeEmit,
    });

    expect(namespaceEmit).toHaveBeenCalledWith(
      "/core",
      "planner.recommendations.updated",
      envelope,
      "home:home-pr1"
    );
    expect(bridgeEmit).toHaveBeenCalledWith({
      ns: "/core",
      event: "planner.recommendations.updated",
      payload: envelope,
      room: "home:home-pr1",
    });

    const counters = getProjectionDeliveryCounters();
    expect(counters.projection_emitted.total).toBe(1);
    expect(counters.projection_emitted.byPlannerHousehold["meal::home-pr1"]).toBe(1);
  });
});
