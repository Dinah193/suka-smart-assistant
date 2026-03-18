// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";

import StorehouseInventoryTable from "../src/pages/storehouse/planner/StorehouseInventoryTable.jsx";

function setInputValue(input, value) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value"
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

describe("storehouse inventory table interaction contract", () => {
  let container;
  let root;

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
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

  it("emits quick-add, qty change, and remove callbacks", async () => {
    const onQuickAdd = vi.fn();
    const onQtyChange = vi.fn();
    const onRemoveRow = vi.fn();

    const rows = [
      {
        id: "lot-1",
        itemName: "Rice",
        qty: 2,
        unit: "kg",
        state: "raw",
        method: null,
        prepTimeReductionPct: 0,
      },
    ];

    await act(async () => {
      root.render(
        React.createElement(StorehouseInventoryTable, {
          rows,
          editable: true,
          onQuickAdd,
          onQtyChange,
          onRemoveRow,
        })
      );
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
      setInputValue(nameInput, "Dry beans");
      setInputValue(qtyInput, "3");
      setInputValue(unitInput, "bag");

      addButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onQuickAdd).toHaveBeenCalledWith({
      itemName: "Dry beans",
      qty: 3,
      unit: "bag",
    });

    const rowQtyInput = container.querySelector('input[aria-label="Quantity for Rice"]');
    expect(rowQtyInput).toBeTruthy();

    await act(async () => {
      setInputValue(rowQtyInput, "7");
    });

    expect(onQtyChange).toHaveBeenCalledWith(expect.objectContaining({ id: "lot-1" }), 7);

    const removeButton = container.querySelector('button[aria-label="Remove Rice"]');
    expect(removeButton).toBeTruthy();

    await act(async () => {
      removeButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onRemoveRow).toHaveBeenCalledWith(expect.objectContaining({ id: "lot-1" }));
  });
});
