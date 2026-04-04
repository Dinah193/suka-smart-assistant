// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React, { act } from "react";
import { createRoot } from "react-dom/client";

const { profileServiceMock } = vi.hoisted(() => ({
  profileServiceMock: {
    loadProfile: vi.fn(),
    subscribe: vi.fn(),
    patchProfile: vi.fn(),
  },
}));

vi.mock("@/services/profile/householdProfileService", () => profileServiceMock);

import ProfileSettingsPage from "../src/pages/settings/ProfileSettingsPage.jsx";

function getActiveStoryGroup(container) {
  return Array.from(container.querySelectorAll('[role="group"]')).find((node) =>
    String(node.getAttribute("aria-label") || "").includes("story card")
  );
}

describe("profile settings media contract", () => {
  let container;
  let root;

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;

    profileServiceMock.loadProfile.mockReset();
    profileServiceMock.subscribe.mockReset();
    profileServiceMock.patchProfile.mockReset();

    profileServiceMock.loadProfile.mockReturnValue({ household: {}, notifications: {} });
    profileServiceMock.subscribe.mockImplementation(() => () => {});

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

  it("supports hover preview, carousel navigation, expand modal, and module microinteractions", async () => {
    await act(async () => {
      root.render(React.createElement(ProfileSettingsPage, { initialTab: "media" }));
    });

    const mediaSection = container.querySelector('section[aria-label="Media tab"]');
    expect(mediaSection).toBeTruthy();

    const firstIndexCard = Array.from(
      container.querySelectorAll('button[aria-label^="Show "]')
    ).find((node) => String(node.getAttribute("aria-label") || "").includes("Dawn irrigation relay"));
    expect(firstIndexCard).toBeTruthy();

    await act(async () => {
      firstIndexCard.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    });

    expect(container.textContent).toContain("Hover to preview moisture, labor, and handoff status.");

    const navNext = container.querySelector('button[aria-label="Next story"]');
    expect(navNext).toBeTruthy();

    await act(async () => {
      navNext.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container.textContent).toContain("Orchard ladder chain");

    const activeStoryGroup = getActiveStoryGroup(container);
    expect(activeStoryGroup).toBeTruthy();

    const beforeKeyLabel = String(activeStoryGroup.getAttribute("aria-label") || "");

    await act(async () => {
      activeStoryGroup.focus();
      activeStoryGroup.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });

    const afterKeyStoryGroup = getActiveStoryGroup(container);
    const afterKeyLabel = String(afterKeyStoryGroup?.getAttribute("aria-label") || "");
    expect(afterKeyLabel.length).toBeGreaterThan(0);

    const expandButton = Array.from(container.querySelectorAll("button")).find((node) =>
      String(node.textContent || "").includes("Expand Story")
    );
    expect(expandButton).toBeTruthy();

    await act(async () => {
      expandButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const dialog = container.querySelector('[role="dialog"]');
    expect(dialog).toBeTruthy();
    const activeStoryTitle = (afterKeyLabel || beforeKeyLabel)
      .replace(/\s*story card$/i, "")
      .trim();
    expect(dialog.textContent).toContain(activeStoryTitle);

    const firstMarkParticipation = Array.from(container.querySelectorAll("button")).find((node) =>
      String(node.textContent || "").trim().startsWith("Mark Participation")
    );
    expect(firstMarkParticipation).toBeTruthy();

    await act(async () => {
      firstMarkParticipation.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const incrementedAction = Array.from(container.querySelectorAll("button")).find((node) =>
      String(node.textContent || "").includes("(1)")
    );

    expect(incrementedAction).toBeTruthy();

    const closeButton = Array.from(container.querySelectorAll("button")).find((node) =>
      String(node.textContent || "").trim() === "Close"
    );
    expect(closeButton).toBeTruthy();

    await act(async () => {
      closeButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container.querySelector('[role="dialog"]')).toBeFalsy();
  });
});
