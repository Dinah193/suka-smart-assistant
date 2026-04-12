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

describe("homestead household agenda cue contract", () => {
  let container;
  let root;
  let appliedPerson;

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    appliedPerson = "";

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
      const parsedUrl = new URL(key, "http://localhost");
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
                module: moduleValue === "homestead" ? "meal" : moduleValue,
                priority: String(parsedUrl.searchParams.get("priority") || ""),
                status: String(parsedUrl.searchParams.get("status") || ""),
              },
              sortBy: String(parsedUrl.searchParams.get("sortBy") || "dueAt"),
              sortDirection: String(parsedUrl.searchParams.get("sortDirection") || "desc"),
              limits: { today: 6, upcoming: 6 },
            },
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

    const agendaCard = Array.from(container.querySelectorAll("section")).find((node) =>
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
      setSelectValue(moduleSelect, "homestead");
      setSelectValue(prioritySelect, "high");
      setSelectValue(statusSelect, "blocked");
      setSelectValue(sortBySelect, "status");
      setSelectValue(sortDirectionSelect, "asc");
      setInputValue(personInput, "member-beta");
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
        (url) => url.includes("module=homestead")
          && url.includes("priority=high")
          && url.includes("status=blocked")
          && url.includes("sortBy=status")
          && url.includes("sortDirection=asc")
          && url.includes("person=member-beta")
      )
    ).toBe(true);
    expect(agendaRequestUrls.some((url) => url.includes("module=meal"))).toBe(true);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(moduleSelect.value).toBe("meal");
    expect(prioritySelect.value).toBe("high");
    expect(statusSelect.value).toBe("blocked");
    expect(sortBySelect.value).toBe("status");
    expect(sortDirectionSelect.value).toBe("asc");
    expect(personInput.value).toBe("member-beta");

    const agendaText = String(agendaCard.textContent || "");
    expect(agendaText).toContain("Applied: meal");
    expect(agendaText).toContain("high priority");
    expect(agendaText).toContain("blocked status");
    expect(agendaText).toContain("person member-beta");
    expect(agendaText).toContain("sort status:asc");
  });
});
