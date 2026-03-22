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
      if (event === "suggestion:list") return { suggestions: [] };
      if (event === "report:request") return { report: { scope: "household", scopeId: "home-metrics" } };
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
import {
  getProjectionReceivedClientCounters,
  resetProjectionReceivedClientCounters,
} from "../src/services/realtime/projectionDeliveryMetrics";

function Harness() {
  useRealtimeCoordination({ householdId: "home-metrics" });
  return React.createElement("div", null, "ok");
}

describe("projection received-client counters", () => {
  let container;
  let root;

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    socketSubscribers.clear();
    socketClient.emitAck.mockClear();
    resetProjectionReceivedClientCounters();
    window.__suka = {
      profile: {
        userId: "metrics-user",
        homeId: "home-metrics",
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

  it("increments projection_received_client counters by planner and household", async () => {
    await act(async () => {
      root.render(React.createElement(Harness));
    });

    await act(async () => {
      await Promise.resolve();
    });

    const handler = socketSubscribers.get("planner:projection:update");
    expect(typeof handler).toBe("function");

    await act(async () => {
      handler({
        eventType: "planner.homestead.production.updated",
        contract: {
          planner: "homestead",
          householdId: "home-metrics",
          queue: { jobId: "job-1" },
        },
      });
    });

    const counters = getProjectionReceivedClientCounters();
    expect(counters.projection_received_client.total).toBe(1);
    expect(counters.projection_received_client.byPlannerHousehold["homestead::home-metrics"]).toBe(
      1
    );
  });
});
