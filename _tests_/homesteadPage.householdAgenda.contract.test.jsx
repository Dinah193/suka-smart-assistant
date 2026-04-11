// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React, { act } from "react";
import { createRoot } from "react-dom/client";

const {
  loadHomesteadPlannerPlanMock,
  fetchHomesteadCollaborationMock,
  upsertHomesteadCollaborationItemMock,
  sendHomesteadCollaborationActionMock,
  resolveHomesteadPlannerIdentityMock,
} = vi.hoisted(() => ({
  loadHomesteadPlannerPlanMock: vi.fn(),
  fetchHomesteadCollaborationMock: vi.fn(),
  upsertHomesteadCollaborationItemMock: vi.fn(),
  sendHomesteadCollaborationActionMock: vi.fn(),
  resolveHomesteadPlannerIdentityMock: vi.fn(),
}));

vi.mock("../src/pages/homesteadplanner/HomesteadPlannerService", () => ({
  loadHomesteadPlannerPlan: (...args) => loadHomesteadPlannerPlanMock(...args),
  fetchHomesteadCollaboration: (...args) => fetchHomesteadCollaborationMock(...args),
  upsertHomesteadCollaborationItem: (...args) =>
    upsertHomesteadCollaborationItemMock(...args),
  sendHomesteadCollaborationAction: (...args) =>
    sendHomesteadCollaborationActionMock(...args),
  saveHomesteadPlannerPlan: vi.fn(async () => ({ ok: true })),
  resolveHomesteadPlannerIdentity: (...args) => resolveHomesteadPlannerIdentityMock(...args),
}));

import HomesteadPlannerPage from "../src/pages/homesteadplanner/homestead.jsx";

describe("homestead household agenda cue contract", () => {
  let container;
  let root;

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;

    resolveHomesteadPlannerIdentityMock.mockReset();
    resolveHomesteadPlannerIdentityMock.mockReturnValue({
      householdId: "household-homestead-ui",
      userId: "homestead-user",
    });

    loadHomesteadPlannerPlanMock.mockReset();
    loadHomesteadPlannerPlanMock.mockResolvedValue({
      plan: {
        id: "plan-a",
        season: "spring",
      },
      snapshot: {
        planId: "plan-a",
      },
    });

    fetchHomesteadCollaborationMock.mockReset();
    fetchHomesteadCollaborationMock.mockResolvedValue({
      collaboration: {
        needs: [],
        offers: [],
        assignments: [],
        fulfillments: [],
        feed: [],
      },
    });

    upsertHomesteadCollaborationItemMock.mockReset();
    upsertHomesteadCollaborationItemMock.mockResolvedValue({
      collaboration: {
        needs: [],
        offers: [],
        assignments: [],
        fulfillments: [],
        feed: [],
      },
    });

    sendHomesteadCollaborationActionMock.mockReset();
    sendHomesteadCollaborationActionMock.mockResolvedValue({
      collaboration: {
        needs: [],
        offers: [],
        assignments: [],
        fulfillments: [],
        feed: [],
      },
    });

    global.fetch = vi.fn(async (url) => {
      const key = String(url || "");
      if (key.includes("/api/planners/household/today-upcoming")) {
        return {
          ok: true,
          json: async () => ({
            ok: true,
            today: [
              {
                id: "agenda-homestead-1",
                title: "Rotate compost bays",
                module: "homestead",
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
      root.render(React.createElement(HomesteadPlannerPage));
    });

    await act(async () => {
      await Promise.resolve();
    });

    const text = String(container.textContent || "");
    expect(text).toContain("Household Today and Upcoming");
    expect(text).toContain("Rotate compost bays");
    expect(text).toContain("homestead | blocked | high | recurring");
    expect(text).toContain("blocked by 2 deps");
    expect(text).toContain("conflicts 1");
    expect(text).toContain("overdue");

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/planners/household/today-upcoming"),
      expect.objectContaining({ credentials: "include" })
    );
  });
});
