// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React, { act } from "react";
import { createRoot } from "react-dom/client";

const { fetchStorehousePlannerDataMock } = vi.hoisted(() => ({
  fetchStorehousePlannerDataMock: vi.fn(),
}));

vi.mock("@/context/VisionContext", () => ({
  useVision: () => ({ options: {} }),
}));

vi.mock("@/components/home/RealtimeCoordinationPanel", () => ({
  default: () => React.createElement("div", null, "RealtimeCoordinationPanel"),
}));

vi.mock("@/services/realtime/canonicalSignalEmitter", () => ({
  emitCanonicalSignal: vi.fn(),
}));

vi.mock("@/ui/AutomationPanel", () => ({
  default: ({ children }) => React.createElement("div", null, children),
}));

vi.mock("@/components/sacred", () => ({
  Avatar: ({ name }) => React.createElement("div", null, name),
  Button: ({ children, onClick, disabled }) =>
    React.createElement("button", { onClick, disabled, type: "button" }, children),
  Card: ({ title, children }) => React.createElement("section", null, title, children),
  DashboardGrid: ({ children }) => React.createElement("div", null, children),
  FeedPost: ({ content }) => React.createElement("article", null, content),
  Notification: ({ title }) => React.createElement("div", null, title),
}));

vi.mock("@/services/telemetry/productActionTelemetry", () => ({
  recordProductActionClick: vi.fn(),
  recordProductActionImpression: vi.fn(),
}));

vi.mock("@/pages/storehouse/planner/InventoryEstimatorService", () => ({
  fetchStorehousePlannerData: (...args) => fetchStorehousePlannerDataMock(...args),
}));

vi.mock("@/components/common/LoadingBoundary", () => ({
  default: ({ children }) => React.createElement(React.Fragment, null, children),
}));

import StorehousePage from "../src/pages/storehouse/storehouse.jsx";

describe("storehouse household agenda cue contract", () => {
  let container;
  let root;

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    fetchStorehousePlannerDataMock.mockReset();
    fetchStorehousePlannerDataMock.mockResolvedValue({
      projection: {
        weekly: {
          eggs: 4,
          milkLiters: 2,
          produceKg: 3,
          meatKg: 1,
        },
      },
      inventory: [],
    });

    window.__suka = {
      profile: {
        householdId: "household-storehouse-ui",
      },
    };

    global.fetch = vi.fn(async (url) => {
      const key = String(url || "");
      if (key.includes("/api/planners/storehouse/context")) {
        return {
          ok: true,
          json: async () => ({
            feed: [],
            alerts: [],
          }),
        };
      }
      if (key.includes("/api/planners/household/today-upcoming")) {
        return {
          ok: true,
          json: async () => ({
            ok: true,
            today: [
              {
                id: "agenda-storehouse-1",
                title: "Check grain bins",
                module: "storehouse",
                workflowState: "blocked",
                priority: "high",
                recurrenceEnabled: true,
                hasDependencyBlock: true,
                blockingDependencyCount: 2,
                hasConflict: true,
                conflictCount: 1,
                overdue: true,
              },
            ],
            upcoming: [],
          }),
        };
      }
      return {
        ok: false,
        json: async () => ({}),
      };
    });

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
    root = null;
    container = null;
    globalThis.IS_REACT_ACT_ENVIRONMENT = false;
  });

  it("renders household agenda panel with recurrence/dependency/conflict cues", async () => {
    await act(async () => {
      root.render(React.createElement(StorehousePage));
    });

    await act(async () => {
      await Promise.resolve();
    });

    const text = String(container.textContent || "");
    expect(text).toContain("Household Today and Upcoming");
    expect(text).toContain("Check grain bins");
    expect(text).toContain("storehouse | blocked | high | recurring");
    expect(text).toContain("blocked by 2 deps");
    expect(text).toContain("conflicts 1");
    expect(text).toContain("overdue");

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/planners/household/today-upcoming"),
      expect.objectContaining({ credentials: "include" })
    );
  });
});
