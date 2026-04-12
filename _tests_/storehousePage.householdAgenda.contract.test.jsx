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

describe("storehouse household agenda cue contract", () => {
  let container;
  let root;
  let appliedPerson;

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    appliedPerson = "";
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
      const parsedUrl = new URL(key, "http://localhost");
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
        const moduleValue = String(parsedUrl.searchParams.get("module") || "");
        const requestedPerson = String(parsedUrl.searchParams.get("person") || "").trim().toLowerCase();
        if (requestedPerson) {
          appliedPerson = requestedPerson;
        }
        return {
          ok: true,
          json: async () => ({
            ok: true,
            applied: {
              filters: {
                person: appliedPerson,
                module: moduleValue === "storehouse" ? "community" : moduleValue,
                priority: String(parsedUrl.searchParams.get("priority") || ""),
                status: String(parsedUrl.searchParams.get("status") || ""),
              },
              sortBy: String(parsedUrl.searchParams.get("sortBy") || "dueAt"),
              sortDirection: String(parsedUrl.searchParams.get("sortDirection") || "desc"),
              limits: { today: 6, upcoming: 6 },
            },
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

    const agendaCard = Array.from(container.querySelectorAll("div")).find((node) =>
      String(node.textContent || "").includes("Household Today and Upcoming")
    );
    expect(agendaCard).toBeTruthy();

    const selects = Array.from(agendaCard.querySelectorAll("select"));
    expect(selects.length).toBeGreaterThanOrEqual(5);
    const [moduleSelect, prioritySelect, statusSelect, sortBySelect, sortDirectionSelect] = selects;
    const personInput = agendaCard.querySelector('input[placeholder="Filter by person handle"]');
    const applyButton = Array.from(agendaCard.querySelectorAll("button")).find(
      (node) => String(node.textContent || "").trim() === "Apply Person"
    );

    expect(personInput).toBeTruthy();
    expect(applyButton).toBeTruthy();

    await act(async () => {
      setSelectValue(moduleSelect, "storehouse");
      setSelectValue(prioritySelect, "high");
      setSelectValue(statusSelect, "blocked");
      setSelectValue(sortBySelect, "status");
      setSelectValue(sortDirectionSelect, "asc");
      setInputValue(personInput, "member-alpha");
      applyButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    await act(async () => {
      await Promise.resolve();
    });

    const agendaRequestUrls = global.fetch.mock.calls
      .map(([url]) => String(url || ""))
      .filter((url) => url.includes("/api/planners/household/today-upcoming"));
    expect(agendaRequestUrls.length).toBeGreaterThan(0);
    expect(
      agendaRequestUrls.some(
        (url) => url.includes("module=storehouse")
          && url.includes("priority=high")
          && url.includes("status=blocked")
          && url.includes("sortBy=status")
          && url.includes("sortDirection=asc")
          && url.includes("person=member-alpha")
      )
    ).toBe(true);
    expect(agendaRequestUrls.some((url) => url.includes("module=community"))).toBe(true);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(moduleSelect.value).toBe("community");
    expect(prioritySelect.value).toBe("high");
    expect(statusSelect.value).toBe("blocked");
    expect(sortBySelect.value).toBe("status");
    expect(sortDirectionSelect.value).toBe("asc");
    expect(personInput.value).toBe("member-alpha");

    const agendaText = String(agendaCard.textContent || "");
    expect(agendaText).toContain("Applied: community");
    expect(agendaText).toContain("high priority");
    expect(agendaText).toContain("blocked status");
    expect(agendaText).toContain("person member-alpha");
    expect(agendaText).toContain("sort status:asc");
  });
});
