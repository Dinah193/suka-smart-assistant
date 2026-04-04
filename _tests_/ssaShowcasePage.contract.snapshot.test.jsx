// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";

import SSAShowcasePage from "../src/pages/design/ssa-showcase.jsx";

function findSectionByAriaLabel(container, ariaLabel) {
  return container.querySelector(`section[aria-label=\"${ariaLabel}\"]`);
}

describe("SSA showcase page contract and visual snapshots", () => {
  let container;
  let root;

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
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
    vi.useRealTimers();
    globalThis.IS_REACT_ACT_ENVIRONMENT = false;
  });

  it("renders required SSA design-system sections and interaction states", async () => {
    await act(async () => {
      root.render(React.createElement(SSAShowcasePage));
    });

    expect(container.textContent).toContain("SSA Visual Design System");
    expect(container.textContent).toContain("Color, Typography, Spacing, and Rhythm");
    expect(container.textContent).toContain("Component State Gallery");
    expect(container.textContent).toContain("Household Collaboration Cues by Module");
    expect(container.textContent).toContain("Motion and Interaction Demos");
    expect(container.textContent).toContain(
      "Tailwind/CSS Guidance and Animation Recommendations"
    );

    const completionSlider = container.querySelector('input[aria-label="Module completion"]');
    expect(completionSlider).toBeTruthy();

    const runButton = Array.from(container.querySelectorAll("button")).find(
      (node) => String(node.textContent || "").trim() === "Run"
    );
    expect(runButton).toBeTruthy();

    await act(async () => {
      runButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await vi.advanceTimersByTimeAsync(950);
    });

    expect(container.textContent).toContain("Success");
  });

  it("matches token overview and seasonal cue matrix visuals", async () => {
    await act(async () => {
      root.render(React.createElement(SSAShowcasePage));
    });

    const tokenSection = findSectionByAriaLabel(container, "Token overview");
    const cuesSection = findSectionByAriaLabel(
      container,
      "Household module seasonal cues"
    );

    expect(tokenSection?.outerHTML || "").toMatchSnapshot();
    expect(cuesSection?.outerHTML || "").toMatchSnapshot();
  });
});
