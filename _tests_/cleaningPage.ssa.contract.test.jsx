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

describe("cleaning page SSA migration contract", () => {
  let container;
  let root;
  let originalWorker;

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
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
      if (key.includes("/api/planners/household/today-upcoming")) {
        return {
          ok: true,
          json: async () => ({
            ok: true,
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

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/planners/household/today-upcoming"),
      expect.objectContaining({ credentials: "include" })
    );
  });
});
