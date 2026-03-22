// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot } from "react-dom/client";

const { fetchMock, updateMock, recsMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  updateMock: vi.fn(),
  recsMock: vi.fn(),
}));

const { eventBusEmitMock } = vi.hoisted(() => ({
  eventBusEmitMock: vi.fn(),
}));

vi.mock("../src/pages/storehouse/planner/InventoryEstimatorService", () => ({
  fetchStorehousePlannerData: (...args) => fetchMock(...args),
  updateStorehouseInventory: (...args) => updateMock(...args),
}));

vi.mock("../src/pages/storehouse/planner/Neo4jStorehouseGraphService", () => ({
  getStorehouseRecommendations: (...args) => recsMock(...args),
}));

vi.mock("../src/services/events/eventBus", () => ({
  eventBus: {
    emit: (...args) => eventBusEmitMock(...args),
  },
}));

vi.mock("../src/components/planners/PlannerDashboardCard", () => ({
  default: ({ title, subtitle, children }) =>
    React.createElement(
      "section",
      null,
      React.createElement("h2", null, title),
      React.createElement("p", null, subtitle),
      children
    ),
}));

import StorehousePlanner from "../src/pages/storehouse/planner/StorehousePlanner.jsx";

function setInputValue(input, value) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value"
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

describe("storehouse planner quick-add low-stock flow contract", () => {
  let container;
  let root;

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    fetchMock.mockReset();
    updateMock.mockReset();
    recsMock.mockReset();
    eventBusEmitMock.mockReset();

    fetchMock.mockResolvedValue({ inventory: [] });
    recsMock.mockResolvedValue([]);
    updateMock.mockResolvedValue({ ok: true });

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

  it("persists quick add, marks low-stock at zero qty, and replenishes from strip", async () => {
    await act(async () => {
      root.render(
        React.createElement(StorehousePlanner, {
          householdId: "hh-flow",
        })
      );
    });

    await act(async () => {
      await Promise.resolve();
    });

    const nameInput = container.querySelector('input[aria-label="Quick add item name"]');
    const qtyInput = container.querySelector('input[aria-label="Quick add quantity"]');
    const unitInput = container.querySelector('input[aria-label="Quick add unit"]');
    const addButton = Array.from(container.querySelectorAll("button")).find((btn) =>
      String(btn.textContent || "").includes("Add item")
    );

    expect(nameInput).toBeTruthy();
    expect(qtyInput).toBeTruthy();
    expect(unitInput).toBeTruthy();
    expect(addButton).toBeTruthy();

    await act(async () => {
      setInputValue(nameInput, "Evidence Lentils");
      setInputValue(qtyInput, "2");
      setInputValue(unitInput, "bag");
      addButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    await act(async () => {
      await Promise.resolve();
    });

    const quickAddCall = updateMock.mock.calls.find(
      ([payload]) => payload?.changeReason === "storehouse_quick_add_ui"
    );
    expect(quickAddCall).toBeTruthy();
    expect(quickAddCall[0]).toMatchObject({
      householdId: "hh-flow",
      updatedBy: "storehouse.planner.ui",
      changeReason: "storehouse_quick_add_ui",
    });
    expect(quickAddCall[0].inventory[0]).toMatchObject({
      itemName: "Evidence Lentils",
      qty: 2,
      unit: "bag",
    });

    const lentilsQtyInput = container.querySelector('input[aria-label="Quantity for Evidence Lentils"]');
    expect(lentilsQtyInput).toBeTruthy();

    await act(async () => {
      setInputValue(lentilsQtyInput, "0");
    });

    await act(async () => {
      await Promise.resolve();
    });

    const qtyEditCall = updateMock.mock.calls.find(
      ([payload]) =>
        payload?.changeReason === "storehouse_qty_edit_ui" &&
        payload?.inventory?.[0]?.itemName === "Evidence Lentils"
    );
    expect(qtyEditCall).toBeTruthy();
    expect(qtyEditCall[0].inventory[0]).toMatchObject({
      itemName: "Evidence Lentils",
      qty: 0,
      unit: "bag",
    });

    const allText = String(container.textContent || "");
    expect(allText).toContain("Low-stock alert strip");
    expect(allText).toContain("Evidence Lentils");

    const replenishBtn = Array.from(container.querySelectorAll("button")).find((btn) =>
      String(btn.textContent || "").includes("Replenish to 1 bag")
    );
    expect(replenishBtn).toBeTruthy();

    await act(async () => {
      replenishBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const replenishCall = updateMock.mock.calls.find(
      ([payload]) =>
        payload?.changeReason === "low_stock_replenish_ui" &&
        payload?.inventory?.[0]?.itemName === "Evidence Lentils"
    );

    expect(replenishCall).toBeTruthy();
    expect(replenishCall[0].inventory[0]).toMatchObject({
      itemName: "Evidence Lentils",
      qty: 1,
      unit: "bag",
    });
  });

  it("emits row-level telemetry for retry and undo usage", async () => {
    fetchMock.mockResolvedValue({
      inventory: [
        {
          id: "telemetry-1",
          itemName: "Telemetry Beans",
          qty: 4,
          unit: "bag",
          state: "raw",
          method: null,
          prepTimeReductionPct: 0,
        },
      ],
    });
    updateMock
      .mockRejectedValueOnce(new Error("save failed"))
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true });

    await act(async () => {
      root.render(
        React.createElement(StorehousePlanner, {
          householdId: "hh-telemetry",
        })
      );
    });

    await act(async () => {
      await Promise.resolve();
    });

    const qtyInput = container.querySelector('input[aria-label="Quantity for Telemetry Beans"]');
    expect(qtyInput).toBeTruthy();

    await act(async () => {
      setInputValue(qtyInput, "1");
    });

    await act(async () => {
      await Promise.resolve();
    });

    const retryButton = container.querySelector('button[aria-label="Retry Telemetry Beans"]');
    const undoButton = container.querySelector('button[aria-label="Undo Telemetry Beans"]');
    expect(retryButton).toBeTruthy();
    expect(undoButton).toBeTruthy();

    await act(async () => {
      retryButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    await act(async () => {
      undoButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    expect(eventBusEmitMock).toHaveBeenCalledWith(
      "storehouse:row-action",
      expect.objectContaining({
        action: "retry",
        status: "attempt",
        householdId: "hh-telemetry",
        itemName: "Telemetry Beans",
      })
    );
    expect(eventBusEmitMock).toHaveBeenCalledWith(
      "storehouse:row-action",
      expect.objectContaining({
        action: "retry",
        status: "success",
        householdId: "hh-telemetry",
        itemName: "Telemetry Beans",
      })
    );
    expect(eventBusEmitMock).toHaveBeenCalledWith(
      "storehouse:row-action",
      expect.objectContaining({
        action: "undo",
        status: "attempt",
        householdId: "hh-telemetry",
        itemName: "Telemetry Beans",
      })
    );
    expect(eventBusEmitMock).toHaveBeenCalledWith(
      "storehouse:row-action",
      expect.objectContaining({
        action: "undo",
        status: "success",
        householdId: "hh-telemetry",
        itemName: "Telemetry Beans",
      })
    );
  });
});
