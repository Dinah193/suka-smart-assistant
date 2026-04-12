// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";

vi.mock("react-router-dom", () => ({
  useNavigate: () => vi.fn(),
}));

import CleaningPage from "../src/pages/cleaning/index.jsx";

async function clickByText(container, text) {
  const target = Array.from(container.querySelectorAll("button")).find(
    (node) => String(node.textContent || "").trim() === text
  );
  if (!target) throw new Error(`button_not_found:${text}`);
  await act(async () => {
    target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  return target;
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

describe("cleaning page SSA migration contract", () => {
  let container;
  let root;
  let originalWorker;
  let appliedPerson;

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    appliedPerson = "";
    originalWorker = globalThis.Worker;
    globalThis.Worker = class WorkerMock {
      constructor() {
        this.onmessage = null;
      }
      postMessage() {}
      terminate() {}
    };
    localStorage.clear();
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
                module: moduleValue === "cleaning" ? "homestead" : moduleValue,
                priority: String(parsedUrl.searchParams.get("priority") || ""),
                status: String(parsedUrl.searchParams.get("status") || ""),
              },
              sortBy: String(parsedUrl.searchParams.get("sortBy") || "dueAt"),
              sortDirection: String(parsedUrl.searchParams.get("sortDirection") || "desc"),
              limits: { today: 6, upcoming: 6 },
            },
            today: [
              {
                id: "clean-agenda-1",
                title: "Reset kitchen station",
                module: "cleaning",
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
    globalThis.Worker = originalWorker;
    globalThis.IS_REACT_ACT_ENVIRONMENT = false;
  });

  it("preserves generation controls and seasonal SSA cues", async () => {
    await act(async () => {
      root.render(React.createElement(CleaningPage));
    });

    expect(container.textContent).toContain("Cleaning");
    expect(container.textContent).toContain("Generate Cleaning Plan");
    expect(container.textContent).toContain("Seasonal Completion");
    expect(container.textContent).toContain("Cleaning Participation");
    expect(container.textContent).toContain("Household Today and Upcoming");

    await act(async () => {
      await Promise.resolve();
    });

    const text = String(container.textContent || "");
    expect(text).toContain("Reset kitchen station");
    expect(text).toContain("cleaning | blocked | high | recurring");
    expect(text).toContain("blocked by 2 deps");
    expect(text).toContain("conflicts 1");
    expect(text).toContain("overdue");

    const deepChip = await clickByText(container, "Deep");
    expect(deepChip.className).toContain("sv-chip");
    expect(container.textContent).toContain("Deep clean");

    const kitchenBefore = findButtonByText(container, "Kitchen");
    expect(kitchenBefore).toBeTruthy();
    expect(kitchenBefore.className).toContain("is-active");

    await clickByText(container, "Kitchen");

    const kitchenAfter = findButtonByText(container, "Kitchen");
    expect(kitchenAfter).toBeTruthy();
    expect(kitchenAfter.className).not.toContain("is-active");

    const agendaCard = Array.from(container.querySelectorAll("div")).find((node) =>
      String(node.textContent || "").includes("Household Today and Upcoming")
    );
    expect(agendaCard).toBeTruthy();

    const selects = Array.from(agendaCard.querySelectorAll("select"));
    expect(selects.length).toBeGreaterThanOrEqual(5);
    const moduleSelect = selects.find((node) =>
      Array.from(node.querySelectorAll("option")).some((option) => option.value === "community")
    );
    const prioritySelect = selects.find((node) =>
      Array.from(node.querySelectorAll("option")).some((option) => option.value === "critical")
    );
    const statusSelect = selects.find((node) =>
      Array.from(node.querySelectorAll("option")).some(
        (option) => option.value === "pending_approval"
      )
    );
    const sortBySelect = selects.find((node) => {
      const values = Array.from(node.querySelectorAll("option")).map((option) => option.value);
      return values.includes("dueAt") && values.includes("priority") && values.includes("status");
    });
    const sortDirectionSelect = selects.find((node) => {
      const values = Array.from(node.querySelectorAll("option")).map((option) => option.value);
      return values.length === 2 && values.includes("asc") && values.includes("desc");
    });
    const personInput = agendaCard.querySelector('input[placeholder="Filter by person handle"]');
    const applyButton = findButtonByText(agendaCard, "Apply Person");

    expect(moduleSelect).toBeTruthy();
    expect(prioritySelect).toBeTruthy();
    expect(statusSelect).toBeTruthy();
    expect(sortBySelect).toBeTruthy();
    expect(sortDirectionSelect).toBeTruthy();
    expect(personInput).toBeTruthy();
    expect(applyButton).toBeTruthy();

    await act(async () => {
      setSelectValue(moduleSelect, "cleaning");
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
        (url) => url.includes("module=cleaning")
          && url.includes("priority=high")
          && url.includes("status=blocked")
          && url.includes("sortBy=status")
          && url.includes("sortDirection=asc")
          && url.includes("person=member-alpha")
      )
    ).toBe(true);
    expect(agendaRequestUrls.some((url) => url.includes("module=homestead"))).toBe(true);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(moduleSelect.value).toBe("homestead");
    expect(prioritySelect.value).toBe("high");
    expect(statusSelect.value).toBe("blocked");
    expect(sortBySelect.value).toBe("status");
    expect(sortDirectionSelect.value).toBe("asc");
    expect(personInput.value).toBe("member-alpha");

    const agendaText = String(agendaCard.textContent || "");
    expect(agendaText).toContain("Applied: homestead");
    expect(agendaText).toContain("high priority");
    expect(agendaText).toContain("blocked status");
    expect(agendaText).toContain("person member-alpha");
    expect(agendaText).toContain("sort status:asc");

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/planners/household/today-upcoming"),
      expect.objectContaining({ credentials: "include" })
    );
  });
});
