// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";

const { socketSubscribers, socketClient } = vi.hoisted(() => ({
  socketSubscribers: new Map(),
  socketClient: {
    connected: true,
    connecting: false,
    socket: {
      connect: vi.fn(),
    },
    emitAck: vi.fn(async (event) => {
      if (event === "suggestion:list") {
        return { suggestions: [] };
      }
      if (event === "report:request") {
        return { report: { scope: "household", scopeId: "home-e2e" } };
      }
      return {};
    }),
    subscribe: (event, handler) => {
      socketSubscribers.set(String(event), handler);
      return () => {
        socketSubscribers.delete(String(event));
      };
    },
  },
}));

vi.mock("../src/hooks/useSocket", () => ({
  useSocket: () => socketClient,
}));

import useRealtimeCoordination from "../src/hooks/useRealtimeCoordination";
import { eventBus } from "../src/services/events/eventBus";
import { persistMealPlannerGeneration } from "../src/pages/mealplanner/mealPlannerPersistence";

const {
  bridgeProjectionRealtimeEvent,
} = require("../src/server/services/planners/PlannerRealtimeBridge.js");

function PlannerClientHarness() {
  useRealtimeCoordination({ householdId: "home-e2e" });
  return React.createElement("div", { "data-testid": "planner-client-state" }, "ready");
}

describe("planner end-to-end regression", () => {
  let container;
  let root;

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    socketSubscribers.clear();
    socketClient.emitAck.mockClear();
    socketClient.socket.connect.mockClear();
    window.__suka = {
      profile: {
        userId: "meal-user-e2e",
        homeId: "home-e2e",
      },
    };

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root.unmount();
      });
    }
    container?.remove();
    container = null;
    root = null;
    socketSubscribers.clear();
    globalThis.IS_REACT_ACT_ENVIRONMENT = false;
  });

  it("persists generated meal output, emits projection update, and updates client planner listeners", async () => {
    const projectionUpdatedSpy = vi.fn();
    const plannerUpdatedSpy = vi.fn();

    const offProjection = eventBus.on("planner.projection.updated", projectionUpdatedSpy);
    const offPlanner = eventBus.on("planner.storehouse.inventory.updated", plannerUpdatedSpy);

    await act(async () => {
      root.render(React.createElement(PlannerClientHarness));
    });

    await act(async () => {
      await Promise.resolve();
    });

    const saveFn = vi.fn(async (payload) => ({
      ok: true,
      id: payload.id,
      householdId: payload.householdId,
    }));

    const persisted = await persistMealPlannerGeneration({
      normalizedPlan: {
        title: "E2E meal plan",
        summary: "Persistence + projection + client update",
        meals: [{ title: "Veg stew" }],
        shoppingList: [{ name: "Tomatoes", qty: 4, unit: "lb" }],
        prepTasks: [{ title: "Batch prep" }],
      },
      saveAsDraft: false,
      duration: "7-day",
      templateId: "balanced-week",
      cuisines: ["Mediterranean"],
      presets: ["batch-friendly"],
      saveFn,
    });

    expect(persisted.ok).toBe(true);
    expect(persisted.skipped).toBe(false);
    expect(saveFn).toHaveBeenCalledTimes(1);
    expect(persisted.payload.householdId).toBe("home-e2e");

    const projectionContract = {
      planner: "storehouse",
      householdId: persisted.payload.householdId,
      updateType: "inventory.upsert",
      queue: {
        jobId: `job-${persisted.payload.id}`,
      },
      counts: {
        inventoryItems: 1,
      },
    };

    await act(async () => {
      bridgeProjectionRealtimeEvent({
        eventType: "planner.storehouse.inventory.updated",
        contract: projectionContract,
        namespaceEmit: (_ns, event, payload) => {
          const handler = socketSubscribers.get(String(event));
          if (typeof handler === "function") {
            handler(payload);
          }
        },
        bridgeEmit: vi.fn(),
      });
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(socketSubscribers.has("planner:projection:update")).toBe(true);
    expect(projectionUpdatedSpy).toHaveBeenCalledTimes(1);
    expect(plannerUpdatedSpy).toHaveBeenCalledTimes(1);
    expect(projectionUpdatedSpy.mock.calls[0][0]?.data?.contract?.queue?.jobId).toBe(
      projectionContract.queue.jobId
    );
    expect(plannerUpdatedSpy.mock.calls[0][0]?.data?.contract?.queue?.jobId).toBe(
      projectionContract.queue.jobId
    );

    offProjection?.();
    offPlanner?.();
  });
});
