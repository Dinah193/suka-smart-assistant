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

function findButtonByText(container, text) {
  return Array.from(container.querySelectorAll("button")).find((node) =>
    String(node.textContent || "").includes(text)
  );
}

describe("profile settings notifications panel contract", () => {
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

  it("shows module alerts/tasks and supports mark read plus alert detail modal", async () => {
    await act(async () => {
      root.render(React.createElement(ProfileSettingsPage, { initialTab: "posts" }));
    });

    const panel = container.querySelector('section[aria-label="Notifications panel"]');
    expect(panel).toBeTruthy();

    expect(panel.textContent).toContain("Meals and Batch Cooking");
    expect(panel.textContent).toContain("Storehouse Inventory and Replenishment");
    expect(panel.textContent).toContain("Gardens and Orchards");
    expect(panel.textContent).toContain("Animal Husbandry");

    const unreadBefore = panel.textContent.match(/Unread\s+(\d+)/);
    expect(unreadBefore).toBeTruthy();

    const markReadButton = findButtonByText(panel, "Mark Read");
    expect(markReadButton).toBeTruthy();

    await act(async () => {
      markReadButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const unreadAfter = panel.textContent.match(/Unread\s+(\d+)/);
    expect(unreadAfter).toBeTruthy();
    expect(Number(unreadAfter[1])).toBeLessThan(Number(unreadBefore[1]));

    const viewButton = findButtonByText(panel, "View");
    expect(viewButton).toBeTruthy();

    await act(async () => {
      viewButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const dialog = container.querySelector('[role="dialog"]');
    expect(dialog).toBeTruthy();
    expect(dialog.textContent).toContain("Seasonal context");

    const todoSection = container.querySelector('section[aria-label="Module task queue"]');
    expect(todoSection).toBeTruthy();
    expect(todoSection.textContent).toContain("Confirm spring batch menu");
    expect(todoSection.textContent).toContain("Assign milking and butchery handoff");
  });
});
