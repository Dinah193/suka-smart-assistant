// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot } from "react-dom/client";

const { fetchMock, updateMock, recsMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  updateMock: vi.fn(),
  recsMock: vi.fn(),
}));

vi.mock("../src/pages/storehouse/planner/InventoryEstimatorService", () => ({
  fetchStorehousePlannerData: (...args) => fetchMock(...args),
  updateStorehouseInventory: (...args) => updateMock(...args),
}));

vi.mock("../src/pages/storehouse/planner/Neo4jStorehouseGraphService", () => ({
  getStorehouseRecommendations: (...args) => recsMock(...args),
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

describe("storehouse low-stock alert strip UX", () => {
  let container;
  let root;

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    fetchMock.mockReset();
    updateMock.mockReset();
    recsMock.mockReset();

    fetchMock.mockResolvedValue({
      inventory: [
        {
          id: "lot-rice",
          sku: "rice.white",
          itemName: "Rice",
          qty: 1,
          unit: "kg",
          reservedQty: 2,
          metadata: {},
        },
        {
          id: "lot-beans",
          sku: "beans.black",
          itemName: "Beans",
          qty: 7,
          unit: "kg",
          reservedQty: 2,
          metadata: {},
        },
      ],
    });
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
    if (container?.parentNode) {
      container.parentNode.removeChild(container);
    }
    container = null;
    root = null;
    globalThis.IS_REACT_ACT_ENVIRONMENT = false;
  });

  it("shows low-stock items and sends one-click replenish update", async () => {
    await act(async () => {
      root.render(
        React.createElement(StorehousePlanner, {
          householdId: "hh-1",
        })
      );
    });

    await act(async () => {
      await Promise.resolve();
    });

    const text = String(container.textContent || "");
    expect(text).toContain("Low-stock alert strip");
    expect(text).toContain("Rice");
    expect(text).not.toContain("BeansReplenish");

    const replenishBtn = Array.from(container.querySelectorAll("button")).find((button) =>
      String(button.textContent || "").includes("Replenish to")
    );

    expect(replenishBtn).toBeTruthy();

    await act(async () => {
      replenishBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(updateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        householdId: "hh-1",
        changeReason: "low_stock_replenish_ui",
        updatedBy: "storehouse.planner.ui",
      })
    );

    const payload = updateMock.mock.calls[0][0];
    expect(Array.isArray(payload.inventory)).toBe(true);
    expect(payload.inventory[0]).toMatchObject({
      id: "lot-rice",
      itemName: "Rice",
      qty: 4,
      unit: "kg",
    });
  });
});
