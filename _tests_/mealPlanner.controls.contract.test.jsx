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
  FeedPost: ({ title = "feed" }) => React.createElement("div", null, title),
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

function findButtonByText(container, text) {
  return Array.from(container.querySelectorAll("button")).find(
    (node) => String(node.textContent || "").trim() === text
  );
}

function setInputValue(input, value) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value"
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

function setSelectValue(select, value) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLSelectElement.prototype,
    "value"
  )?.set;
  setter?.call(select, value);
  select.dispatchEvent(new Event("input", { bubbles: true }));
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

describe("meal planner controls contract", () => {
  let container;
  let root;
  let fetchMock;

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;

    fetchMock = vi.fn(async (url, options = {}) => {
      const href = String(url);
      const parsedUrl = new URL(href, "http://localhost");

      if (href.includes("/api/planners/meal/context")) {
        return jsonResponse({ ok: true, feed: [], alerts: [] });
      }
      if (href.includes("/api/planners/household/today-upcoming")) {
        const moduleValue = String(parsedUrl.searchParams.get("module") || "");
        return jsonResponse({
          ok: true,
          metrics: { todayCount: 0, upcomingCount: 0 },
          applied: {
            filters: {
              person: String(parsedUrl.searchParams.get("person") || ""),
              module: moduleValue === "cleaning" ? "storehouse" : moduleValue,
              priority: String(parsedUrl.searchParams.get("priority") || ""),
              status: String(parsedUrl.searchParams.get("status") || ""),
            },
            sortBy: String(parsedUrl.searchParams.get("sortBy") || "dueAt"),
            sortDirection: String(parsedUrl.searchParams.get("sortDirection") || "desc"),
            limits: { today: 10, upcoming: 10 },
          },
          today: [],
          upcoming: [],
        });
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

  it("updates template, duration, budget, and prompt controls", async () => {
    await act(async () => {
      root.render(
        React.createElement(
          MemoryRouter,
          { initialEntries: ["/meal-planning?tool=dashboard"] },
          React.createElement(MealPlanningPage)
        )
      );
    });

    await act(async () => {
      await Promise.resolve();
    });

    const selects = Array.from(container.querySelectorAll("select"));
    expect(selects.length).toBeGreaterThan(1);

    const templateSelect = selects.find((node) =>
      Array.from(node.querySelectorAll("option")).some((option) => option.value === "budget-batch")
    );
    const durationSelect = selects.find((node) =>
      Array.from(node.querySelectorAll("option")).some((option) => option.value === "14-day")
    );
    const budgetInput = container.querySelector('input[placeholder="e.g., 120"]');
    const promptInput = container.querySelector(
      'input[placeholder="What should the plan optimize for?"]'
    );

    expect(templateSelect).toBeTruthy();
    expect(durationSelect).toBeTruthy();
    expect(promptInput).toBeTruthy();

    await act(async () => {
      templateSelect.value = "budget-batch";
      templateSelect.dispatchEvent(new Event("change", { bubbles: true }));

      durationSelect.value = "14-day";
      durationSelect.dispatchEvent(new Event("change", { bubbles: true }));

      budgetInput.value = "145";
      budgetInput.dispatchEvent(new Event("input", { bubbles: true }));

      promptInput.value = "Optimize batch prep and pantry rotation for 14 days.";
      promptInput.dispatchEvent(new Event("input", { bubbles: true }));
    });

    expect(templateSelect.value).toBe("budget-batch");
    expect(durationSelect.value).toBe("14-day");
    expect(budgetInput.value).toBe("145");
    expect(promptInput.value).toBe("Optimize batch prep and pantry rotation for 14 days.");

    const agendaCard = Array.from(container.querySelectorAll("div"))
      .find((node) => String(node.textContent || "").includes("Household Today and Upcoming"));
    expect(agendaCard).toBeTruthy();

    const agendaSelects = Array.from(agendaCard.querySelectorAll("select"));
    expect(agendaSelects.length).toBeGreaterThanOrEqual(5);

    const [moduleSelect, prioritySelect, statusSelect, sortBySelect, sortDirectionSelect] = agendaSelects;
    const personInput = agendaCard.querySelector('input[placeholder="Filter by person handle"]');
    const applyPersonButton = findButtonByText(agendaCard, "Apply Person");

    expect(personInput).toBeTruthy();
    expect(applyPersonButton).toBeTruthy();

    await act(async () => {
      setSelectValue(moduleSelect, "cleaning");
      setSelectValue(prioritySelect, "high");
      setSelectValue(statusSelect, "blocked");
      setSelectValue(sortBySelect, "status");
      setSelectValue(sortDirectionSelect, "asc");
      setInputValue(personInput, "Member-Alpha");
      applyPersonButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    await act(async () => {
      await Promise.resolve();
    });

    const agendaRequestUrls = fetchMock.mock.calls
      .map(([url]) => String(url || ""))
      .filter((url) => url.includes("/api/planners/household/today-upcoming"));
    expect(agendaRequestUrls.length).toBeGreaterThan(0);

    expect(
      agendaRequestUrls.some(
        (url) => url.includes("module=cleaning")
          && url.includes("priority=high")
          && url.includes("status=blocked")
          && url.includes("sortBy=status")
          && url.includes("sortDirection=asc")
          && url.includes("person=member-alpha")
      )
    ).toBe(true);
    expect(agendaRequestUrls.some((url) => url.includes("module=storehouse"))).toBe(true);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(moduleSelect.value).toBe("storehouse");
    expect(prioritySelect.value).toBe("high");
    expect(statusSelect.value).toBe("blocked");
    expect(sortBySelect.value).toBe("status");
    expect(sortDirectionSelect.value).toBe("asc");
    expect(personInput.value).toBe("member-alpha");
  });
});
