// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";

vi.mock("@/services/events/eventBus", () => ({
  default: {
    emit: vi.fn(),
    on: vi.fn(() => () => {}),
  },
}));

vi.mock("@/services/automationRuntime", () => ({
  initAutomationRuntime: vi.fn(),
  handleEvent: vi.fn(),
}));

import AppRouter, { ROUTES } from "../src/router.jsx";

async function waitForText(container, text, attempts = 40) {
  for (let index = 0; index < attempts; index += 1) {
    if (String(container.textContent || "").includes(text)) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }
  throw new Error(`text_not_found:${text}`);
}

describe("SSA showcase route smoke contract", () => {
  let container;
  let root;

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    window.history.replaceState({}, "", ROUTES.design_ssa_showcase.path);
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
  });

  it("resolves /design/ssa-showcase and renders SSA design system content", async () => {
    await act(async () => {
      root.render(React.createElement(AppRouter));
    });

    await waitForText(container, "SSA Visual Design System");

    expect(window.location.pathname).toBe(ROUTES.design_ssa_showcase.path);
    expect(container.textContent).toContain("Color, Typography, Spacing, and Rhythm");
  });
});
