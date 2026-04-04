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

describe("profile settings notifications visual snapshots", () => {
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

  it("matches notifications panel baseline", async () => {
    await act(async () => {
      root.render(React.createElement(ProfileSettingsPage, { initialTab: "posts" }));
    });

    const panel = container.querySelector('section[aria-label="Notifications panel"]');
    expect(panel?.outerHTML || "").toMatchSnapshot();
  });

  it("matches notifications detail modal state", async () => {
    await act(async () => {
      root.render(React.createElement(ProfileSettingsPage, { initialTab: "posts" }));
    });

    const viewButton = Array.from(container.querySelectorAll("button")).find((node) =>
      String(node.textContent || "").includes("View")
    );

    await act(async () => {
      viewButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const dialog = container.querySelector('[role="dialog"]');
    expect(dialog?.outerHTML || "").toMatchSnapshot();
  });
});
