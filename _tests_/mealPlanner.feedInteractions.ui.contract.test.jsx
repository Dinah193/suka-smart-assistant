// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";

vi.mock("../src/hooks/useRealtimeCoordination", () => ({
  default: () => ({
    connected: false,
    queueCount: 0,
    suggestions: [],
    report: null,
    reconnect: vi.fn(),
    refreshSuggestions: vi.fn(),
    requestReport: vi.fn(async () => ({ report: { scope: "household", scopeId: "default" } })),
    consumeSuggestion: vi.fn(async () => ({ ok: true })),
    emitCollaborationSignal: vi.fn(async () => ({ ok: true })),
  }),
}));

vi.mock("../src/hooks/estimators/useFoodSecurityEstimator", () => ({
  useFoodSecurityEstimator: () => ({
    loading: false,
    error: null,
    result: { outputs: { coverageDays: 0, confidence: 0 } },
  }),
}));

vi.mock("../src/hooks/estimators/useCostDeltaEstimator", () => ({
  useCostDeltaEstimator: () => ({
    loading: false,
    error: null,
    result: { outputs: { weeklySavings: 0, monthlySavings: 0, confidence: 0 } },
  }),
}));

vi.mock("../src/components/sacred", () => ({
  Avatar: ({ name }) => React.createElement("div", null, name || "avatar"),
  Button: ({ children, loading, ...props }) =>
    React.createElement("button", { ...props, "data-loading": loading ? "true" : "false" }, children),
  Card: ({ children, title }) =>
    React.createElement("div", null, [title ? React.createElement("div", { key: "t" }, title) : null, children]),
  DashboardGrid: ({ children }) => React.createElement("div", null, children),
  FeedPost: ({
    id,
    likes = 0,
    comments = 0,
    shares = 0,
    onLike,
    onComment,
    onShare,
    busyLike = false,
    busyComment = false,
    busyShare = false,
  }) =>
    React.createElement(
      "div",
      { "data-testid": `feed-${id}` },
      React.createElement("div", { "data-testid": `likes-${id}` }, String(likes)),
      React.createElement("div", { "data-testid": `comments-${id}` }, String(comments)),
      React.createElement("div", { "data-testid": `shares-${id}` }, String(shares)),
      React.createElement("div", { "data-testid": `busy-like-${id}` }, busyLike ? "busy" : "idle"),
      React.createElement("div", { "data-testid": `busy-comment-${id}` }, busyComment ? "busy" : "idle"),
      React.createElement("div", { "data-testid": `busy-share-${id}` }, busyShare ? "busy" : "idle"),
      React.createElement(
        "button",
        { type: "button", "data-testid": `like-${id}`, onClick: onLike, disabled: busyLike },
        "Like"
      ),
      React.createElement(
        "button",
        { type: "button", "data-testid": `comment-${id}`, onClick: onComment, disabled: busyComment },
        "Comment"
      ),
      React.createElement(
        "button",
        { type: "button", "data-testid": `share-${id}`, onClick: onShare, disabled: busyShare },
        "Share"
      )
    ),
  Notification: ({ title = "notification" }) => React.createElement("div", null, title),
}));

vi.mock("../src/services/telemetry/productActionTelemetry", () => ({
  recordProductActionClick: vi.fn(),
  recordProductActionImpression: vi.fn(),
}));

vi.mock("../src/pages/planners/HouseholdPlanningService", () => ({
  requestHouseholdAutomationPlan: vi.fn(async () => ({ ok: true })),
}));

vi.mock("../src/services/auth/tokenProvider", () => ({
  getToken: vi.fn(() => ""),
}));

vi.mock("../src/components/common/LoadingBoundary", () => ({
  default: ({ children }) => React.createElement(React.Fragment, null, children),
}));

vi.mock("../src/services/automation/runtime", () => ({
  automation: null,
}));

vi.mock("../src/services/realtime/canonicalSignalEmitter", () => ({
  emitCanonicalSignal: vi.fn(),
}));

vi.mock("../src/services/events/eventBus", () => ({
  eventBus: {
    emit: vi.fn(),
    on: vi.fn(() => () => {}),
  },
}));

vi.mock("../src/services/planners/mealPlannerBridge", () => ({
  emitHomesteadMealPlanGenerated: vi.fn(),
  buildEstimateInputsFromNormalizedPlan: vi.fn(() => ({})),
  emitPlannerGapsUpdated: vi.fn(),
}));

vi.mock("../src/store/StorehousePlannerStore", () => {
  const state = {
    storehouseNeeds: [],
    upsertPreservationTasks: vi.fn(),
  };
  const hook = (selector) => (typeof selector === "function" ? selector(state) : state);
  hook.getState = () => state;
  return { useStorehousePlannerStore: hook };
});

vi.mock("../src/store/homesteadPlannerStore", () => {
  const state = {
    ingest: {
      lastEstimateInputs: null,
      lastGeneratedPlan: null,
      lastIngestedAt: null,
    },
  };
  const hook = (selector) => (typeof selector === "function" ? selector(state) : state);
  hook.getState = () => state;
  return { useHomesteadPlannerStore: hook };
});

vi.mock("../src/context/VisionContext", () => ({
  useVision: () => ({ options: {} }),
}));

vi.mock("../src/store/MealPlanDraftStore", () => {
  const state = {
    selectedDraftId: null,
    listDrafts: () => [],
    getSelectedDraft: () => null,
  };
  return {
    useMealPlanDraftStore: {
      getState: () => state,
      subscribe: () => () => {},
    },
    saveDraft: vi.fn(async () => "draft-1"),
    getDraft: vi.fn(() => null),
    publishDraft: vi.fn(async () => ({ ok: true })),
    exportDraftJSON: vi.fn(() => "{}"),
    importDraftJSON: vi.fn(() => ({ ok: true })),
    renameDraft: vi.fn(() => ({ ok: true })),
    duplicateDraft: vi.fn(() => ({ ok: true })),
    deleteDraft: vi.fn(() => ({ ok: true })),
    selectDraft: vi.fn(() => ({ ok: true })),
  };
});

vi.mock("../src/components/home/RealtimeCoordinationPanel", () => ({
  default: () => React.createElement("div", null, "RealtimeCoordinationPanel"),
}));

vi.mock("../src/components/meals/MealPlannerDashboard.jsx", () => ({
  default: () => React.createElement("div", null, "MealPlannerDashboard"),
}));

vi.mock("../src/pages/mealplanner/MealCyclePlannerCalendar.jsx", () => ({
  default: () => React.createElement("div", null, "MealCyclePlannerCalendar"),
}));

vi.mock("../src/components/meals/MealPrepNeedsReport.jsx", () => ({
  default: () => React.createElement("div", null, "MealPrepNeedsReport"),
}));

vi.mock("../src/components/meals/FoodProductionForecast.jsx", () => ({
  default: () => React.createElement("div", null, "FoodProductionForecast"),
}));

vi.mock("../src/components/meals/ProcurementReport.jsx", () => ({
  default: () => React.createElement("div", null, "ProcurementReport"),
}));

vi.mock("../src/components/meals/ShoppingListGenerator.jsx", () => ({
  default: () => React.createElement("div", null, "ShoppingListGenerator"),
}));

vi.mock("../src/components/meals/MealToMarketScalePanel.jsx", () => ({
  default: () => React.createElement("div", null, "MealToMarketScalePanel"),
}));

vi.mock("../src/components/meals/SeedAnimalInventoryForm.jsx", () => ({
  default: () => React.createElement("div", null, "SeedAnimalInventoryForm"),
}));

vi.mock("../src/components/meals/ZoneAwareCalendar.jsx", () => ({
  default: () => React.createElement("div", null, "ZoneAwareCalendar"),
}));

import MealPlanningPage from "../src/pages/mealplanner/mealplanner.jsx";

function jsonResponse(payload, ok = true, status = 200) {
  return {
    ok,
    status,
    async json() {
      return payload;
    },
  };
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe("meal planner feed interaction UI contract", () => {
  let container;
  let root;
  let fetchMock;
  let feedState;
  let homesteadCollaborationState;
  let failLike;
  let toasts;

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;

    feedState = [
      {
        id: "meal-feed-1",
        author: "Meal Planning Team",
        content: "Feed baseline",
        timestamp: "Now",
        likes: 17,
        comments: 4,
        shares: 2,
      },
    ];
    homesteadCollaborationState = {
      feed: [
        {
          id: "homestead-feed-1",
          author: "Homestead Coordination Team",
          content: "Baseline homestead collaboration post",
          timestamp: "Today 07:15",
          likes: 9,
          coordinates: 2,
          shares: 3,
          updatedBy: null,
          actionLog: [],
        },
      ],
    };
    failLike = false;
    toasts = [];

    window.addEventListener("toast", (event) => {
      toasts.push(event.detail || {});
    });

    fetchMock = vi.fn(async (url, options = {}) => {
      const href = String(url);

      if (href.includes("/api/planners/meal/context/feed/") && href.includes("/action")) {
        if (failLike) {
          return jsonResponse({ ok: false, error: "context_feed_action_failed:500" }, false, 500);
        }

        const body = JSON.parse(String(options.body || "{}"));
        const action = String(body.action || "").toLowerCase();
        const key = action === "like" ? "likes" : action === "comment" ? "comments" : "shares";
        const deltaRaw = Number(body.delta);
        const delta = Number.isFinite(deltaRaw) && deltaRaw !== 0 ? deltaRaw : 1;

        feedState = feedState.map((item) =>
          item.id === "meal-feed-1"
            ? { ...item, [key]: Math.max(0, Number(item[key] || 0) + delta), updatedBy: "dev-local-user" }
            : item
        );

        if (action === "share") {
          homesteadCollaborationState = {
            ...homesteadCollaborationState,
            feed: [
              {
                id: `meal-handoff-meal-feed-1-${Date.now()}`,
                author: "Meal Planner Handoff",
                content:
                  "Meal planner shared an update for cross-module follow-up. Review and coordinate next actions.",
                timestamp: "Now",
                likes: 0,
                coordinates: 0,
                shares: 0,
                source: "meal-planner",
                sourcePostId: "meal-feed-1",
                updatedBy: "dev-local-user",
                lastAction: "handoff_from_meal",
                actionLog: [
                  {
                    action: "handoff_from_meal",
                    updatedBy: "dev-local-user",
                  },
                ],
              },
              ...(homesteadCollaborationState.feed || []),
            ],
          };
        }

        return jsonResponse({ ok: true, householdId: "default-household", feed: feedState, alerts: [] });
      }

      if (href.includes("/api/planners/homestead/collaboration")) {
        return jsonResponse({
          ok: true,
          householdId: "default-household",
          collaboration: homesteadCollaborationState,
        });
      }

      if (href.includes("/api/planners/meal/context")) {
        return jsonResponse({ ok: true, feed: feedState, alerts: [] });
      }
      if (href.includes("/api/planners/meal?")) {
        return jsonResponse({ ok: true, snapshot: {} });
      }
      if (href.includes("/api/planners/storehouse?")) {
        return jsonResponse({ ok: true, summary: {} });
      }
      if (href.includes("/api/planners/operational/readiness/meal?")) {
        return jsonResponse({ ok: true, readiness: {} });
      }
      if (href.includes("/api/planners/projection/status")) {
        return jsonResponse({ ok: true, pendingJobs: 0 });
      }
      if (href.includes("/api/planners/assistant/plan") && options.method === "POST") {
        return jsonResponse({ ok: true, bundle: null });
      }

      return jsonResponse({ ok: true });
    });

    global.fetch = fetchMock;

    window.__suka = {
      profile: {
        userId: "test-user",
        homeId: "default-household",
        roles: ["owner"],
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
    globalThis.IS_REACT_ACT_ENVIRONMENT = false;
    vi.restoreAllMocks();
  });

  it("persists feed counts in UI for successful like/comment/share actions", async () => {
    await act(async () => {
      root.render(
        React.createElement(
          MemoryRouter,
          { initialEntries: ["/meal-planning?tool=dashboard"] },
          React.createElement(MealPlanningPage)
        )
      );
    });

    await flush();

    const likes = container.querySelector('[data-testid="likes-meal-feed-1"]');
    const comments = container.querySelector('[data-testid="comments-meal-feed-1"]');
    const shares = container.querySelector('[data-testid="shares-meal-feed-1"]');

    expect(likes.textContent).toBe("17");
    expect(comments.textContent).toBe("4");
    expect(shares.textContent).toBe("2");

    await act(async () => {
      container.querySelector('[data-testid="like-meal-feed-1"]').click();
    });
    await flush();

    await act(async () => {
      container.querySelector('[data-testid="comment-meal-feed-1"]').click();
    });
    await flush();

    await act(async () => {
      container.querySelector('[data-testid="share-meal-feed-1"]').click();
    });
    await flush();

    expect(container.querySelector('[data-testid="likes-meal-feed-1"]').textContent).toBe("18");
    expect(container.querySelector('[data-testid="comments-meal-feed-1"]').textContent).toBe("5");
    expect(container.querySelector('[data-testid="shares-meal-feed-1"]').textContent).toBe("3");
    expect(container.querySelector('[data-testid="busy-like-meal-feed-1"]').textContent).toBe("idle");
  });

  it("keeps prior count and emits error toast when a feed action fails", async () => {
    failLike = true;

    await act(async () => {
      root.render(
        React.createElement(
          MemoryRouter,
          { initialEntries: ["/meal-planning?tool=dashboard"] },
          React.createElement(MealPlanningPage)
        )
      );
    });

    await flush();

    const likeButton = container.querySelector('[data-testid="like-meal-feed-1"]');
    expect(container.querySelector('[data-testid="likes-meal-feed-1"]').textContent).toBe("17");

    await act(async () => {
      likeButton.click();
    });
    await flush();

    expect(container.querySelector('[data-testid="likes-meal-feed-1"]').textContent).toBe("17");
    expect(container.querySelector('[data-testid="busy-like-meal-feed-1"]').textContent).toBe("idle");
    expect(toasts.some((entry) => entry?.type === "error")).toBe(true);
  });

  it("verifies share interaction creates cross-module homestead handoff state", async () => {
    await act(async () => {
      root.render(
        React.createElement(
          MemoryRouter,
          { initialEntries: ["/meal-planning?tool=dashboard"] },
          React.createElement(MealPlanningPage)
        )
      );
    });

    await flush();

    await act(async () => {
      container.querySelector('[data-testid="share-meal-feed-1"]').click();
    });
    await flush();

    const res = await fetch("/api/planners/homestead/collaboration?householdId=default-household");
    expect(res.ok).toBe(true);
    const payload = await res.json();
    const topFeedEntry = payload?.collaboration?.feed?.[0] || null;

    expect(topFeedEntry).toMatchObject({
      author: "Meal Planner Handoff",
      source: "meal-planner",
      sourcePostId: "meal-feed-1",
      updatedBy: "dev-local-user",
      lastAction: "handoff_from_meal",
    });
  });
});
