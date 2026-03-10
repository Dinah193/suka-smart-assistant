// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot } from "react-dom/client";

const { emitMock, upsertNeedsMock } = vi.hoisted(() => ({
  emitMock: vi.fn(),
  upsertNeedsMock: vi.fn(),
}));

vi.mock("../src/services/events/eventBus.js", () => ({
  eventBus: {
    emit: emitMock,
  },
}));

vi.mock("../src/store/StorehousePlannerStore.js", () => ({
  useStorehousePlannerStore: {
    getState: () => ({
      upsertNeeds: upsertNeedsMock,
    }),
  },
}));

vi.mock("../src/services/automation/runtime", () => ({
  automation: null,
}));

import ShoppingListGenerator from "../src/components/meals/ShoppingListGenerator.jsx";

describe("meal planner bridge UI action path", () => {
  let container;
  let root;

  beforeEach(() => {
    emitMock.mockClear();
    upsertNeedsMock.mockClear();

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
    if (container && container.parentNode) {
      container.parentNode.removeChild(container);
    }
    container = null;
    root = null;
  });

  it("forwards from UI button click to storehouse ingest and emits bridge events", async () => {
    const recipes = [
      {
        id: "r1",
        title: "Pasta Night",
        ingredients: [
          { name: "Tomatoes", qty: 6, unit: "lb" },
          { name: "Garlic", qty: 2, unit: "unit" },
        ],
      },
    ];

    await act(async () => {
      root.render(
        React.createElement(ShoppingListGenerator, {
          recipes,
          stewardshipMode: false,
          sessionId: "ui-session-1",
        })
      );
    });

    // Ignore mount-time shoppingList.updated emission and focus on click path emissions.
    emitMock.mockClear();

    const button = Array.from(container.querySelectorAll("button")).find((b) =>
      String(b.textContent || "").includes("Send missing & short items to Grocery flow")
    );

    expect(button).toBeTruthy();

    await act(async () => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(upsertNeedsMock).toHaveBeenCalledTimes(1);
    const forwardedNeeds = upsertNeedsMock.mock.calls[0][0];
    expect(Array.isArray(forwardedNeeds)).toBe(true);
    expect(forwardedNeeds.length).toBe(2);
    expect(forwardedNeeds[0]).toMatchObject({
      category: "meal-planner",
      source: "meal-planner",
    });

    expect(emitMock).toHaveBeenCalledWith(
      "storehouse.planner.ingest.requested",
      expect.objectContaining({
        contractVersion: "storehouse.ingest.v1",
        source: "meal-planner",
        sessionId: "ui-session-1",
        count: 2,
      })
    );

    expect(emitMock).toHaveBeenCalledWith(
      "storehouse.planner.ingest.completed",
      expect.objectContaining({
        contractVersion: "storehouse.ingest.v1",
        source: "meal-planner",
        sessionId: "ui-session-1",
        forwarded: true,
      })
    );

    expect(emitMock).toHaveBeenCalledWith(
      "shoppingList.sentToGrocery",
      expect.objectContaining({
        sessionId: "ui-session-1",
        count: 2,
      })
    );
  });
});
