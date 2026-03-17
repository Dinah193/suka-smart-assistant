// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { notifyWarningMock } = vi.hoisted(() => ({
  notifyWarningMock: vi.fn(),
}));

vi.mock("../src/ui/ux/feedback.js", () => ({
  notifyInfo: vi.fn(),
  notifySuccess: vi.fn(),
  notifyWarning: (...args) => notifyWarningMock(...args),
  notifyError: vi.fn(),
}));

import MealplannerDraftFormatter from "../src/formatters/mealplanner/mealplannerDraftFormatter.jsx";
import HomesteadplannerDraftFormatter from "../src/formatters/homesteadplanner/homesteadplannerDraftFormatter.jsx";
import GardenDraftFormatter from "../src/formatters/garden/gardenDraftFormatter.js";
import CookingDraftFormatter from "../src/formatters/cooking/cookingDraftFormatter.js";
import CleaningDraftFormatter from "../src/formatters/cleaning/cleaningDraftFormatter.jsx";
import {
  CLAMP_HINT_TEXT,
  useNonNegativeClampHints,
} from "../src/ui/ux/useNonNegativeClampHints.js";

function sourceOf(relPath) {
  return readFileSync(resolve(process.cwd(), relPath), "utf8");
}

function ClampHarness({ trackedPath = "inventoryAlerts[0].neededQty", expose }) {
  const api = useNonNegativeClampHints({
    paths: [/^inventoryAlerts\[\d+\]\.neededQty$/],
    warningTitle: "Inventory quantity adjusted",
    warningDescription:
      "Negative values were clamped to zero for inventory-related fields.",
  });

  expose.current = api;

  if (api.clampHints[trackedPath]) {
    return React.createElement("div", { className: "ssa-clamp-hint" }, CLAMP_HINT_TEXT);
  }

  return React.createElement("div", null);
}

describe("formatter non-negative clamp contract", () => {
  let container;
  let root;

  beforeEach(() => {
    notifyWarningMock.mockClear();
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
  });

  it("shared clamp hook enforces non-negative value, toggles inline hint, and warns once", async () => {
    const expose = { current: null };

    await act(async () => {
      root.render(
        React.createElement(ClampHarness, {
          trackedPath: "inventoryAlerts[0].neededQty",
          expose,
        })
      );
    });

    expect(expose.current).toBeTruthy();

    await act(async () => {
      const sanitized = expose.current.sanitizeFieldValue(
        "inventoryAlerts[0].neededQty",
        -2
      );
      expect(sanitized).toBe(0);
    });

    expect(container.querySelectorAll(".ssa-clamp-hint").length).toBe(1);

    await act(async () => {
      const sanitized = expose.current.sanitizeFieldValue(
        "inventoryAlerts[0].neededQty",
        -5
      );
      expect(sanitized).toBe(0);
    });

    await act(async () => {
      const sanitized = expose.current.sanitizeFieldValue(
        "inventoryAlerts[0].neededQty",
        ""
      );
      expect(sanitized).toBe("");
    });
    expect(container.querySelectorAll(".ssa-clamp-hint").length).toBe(0);

    await act(async () => {
      const sanitized = expose.current.sanitizeFieldValue(
        "inventoryAlerts[0].neededQty",
        -1
      );
      expect(sanitized).toBe(0);
    });

    expect(container.querySelectorAll(".ssa-clamp-hint").length).toBe(1);
    expect(notifyWarningMock).toHaveBeenCalledTimes(1);
  });

  it("mealplanner formatter keeps clamp contracts on tracked paths", async () => {
    await act(async () => {
      root.render(React.createElement(MealplannerDraftFormatter, { editable: true }));
    });
    const source = sourceOf("src/formatters/mealplanner/mealplannerDraftFormatter.jsx");
    expect(source).toContain("useNonNegativeClampHints");
    expect(source).toContain("shoppingList[${i}].qty");
    expect(source).toContain("inventoryAlerts[${i}].neededQty");
    expect(source).toContain('className="ssa-clamp-hint"');
    expect(source).toContain("min={0}");
  });

  it("homestead formatter keeps clamp contracts on tracked paths", async () => {
    await act(async () => {
      root.render(
        React.createElement(HomesteadplannerDraftFormatter, { editable: true })
      );
    });
    const source = sourceOf(
      "src/formatters/homesteadplanner/homesteadplannerDraftFormatter.jsx"
    );
    expect(source).toContain("useNonNegativeClampHints");
    expect(source).toContain("resources[${i}].qty");
    expect(source).toContain("inventoryAlerts[${i}].neededQty");
    expect(source).toContain('className="ssa-clamp-hint"');
    expect(source).toContain("min={0}");
  });

  it("garden formatter keeps clamp contracts on tracked paths", async () => {
    await act(async () => {
      root.render(React.createElement(GardenDraftFormatter, { editable: true }));
    });
    const source = sourceOf("src/formatters/garden/gardenDraftFormatter.js");
    expect(source).toContain("useNonNegativeClampHints");
    expect(source).toContain("harvestTargets[${i}].qty");
    expect(source).toContain("soilAmendments[${i}].qty");
    expect(source).toContain("inventoryAlerts[${i}].neededQty");
    expect(source).toContain('className="ssa-clamp-hint"');
    expect(source).toContain("min={0}");
  });

  it("cooking formatter keeps clamp contracts on tracked paths", async () => {
    await act(async () => {
      root.render(React.createElement(CookingDraftFormatter, { editable: true }));
    });
    const source = sourceOf("src/formatters/cooking/cookingDraftFormatter.js");
    expect(source).toContain("useNonNegativeClampHints");
    expect(source).toContain("ingredients[${i}].qty");
    expect(source).toContain("inventoryAlerts[${i}].neededQty");
    expect(source).toContain('className="ssa-clamp-hint"');
    expect(source).toContain("min={0}");
  });

  it("cleaning formatter keeps clamp contracts on tracked paths", async () => {
    await act(async () => {
      root.render(React.createElement(CleaningDraftFormatter, { editable: true }));
    });
    const source = sourceOf("src/formatters/cleaning/cleaningDraftFormatter.jsx");
    expect(source).toContain("useNonNegativeClampHints");
    expect(source).toContain("inventoryAlerts[${i}].neededQty");
    expect(source).toContain('className="ssa-clamp-hint"');
    expect(source).toContain("min={0}");
  });
});
