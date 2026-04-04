// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React, { act } from "react";
import { createRoot } from "react-dom/client";

const { profileServiceMock, eventBusMock, getDirectMessagingFixture } = vi.hoisted(() => {
  function directMessagingFixture() {
    return {
      conversations: [
        {
          id: "dm-1",
          household: "Willow Collective",
          animal: "chickens",
          unread: 0,
          status: "assigned",
          lastAt: "2m ago",
          lastMessage: "Can we shift evening batch prep after orchard pass?",
          moduleParticipation: [],
          thread: [
            {
              id: "dm-1-msg-1",
              from: "other",
              body: "Can we shift evening batch prep after orchard pass?",
              moduleKey: "meals",
              seasonalCue: "Spring herb menu closes tonight",
              at: "5:44 PM",
            },
          ],
        },
        {
          id: "dm-2",
          household: "Oak and Hearth",
          animal: "goats",
          unread: 0,
          status: "request",
          lastAt: "14m ago",
          lastMessage: "Need orchard milestone update before canning run.",
          moduleParticipation: [],
          thread: [
            {
              id: "dm-2-msg-1",
              from: "other",
              body: "Need orchard milestone update before canning run.",
              moduleKey: "gardens",
              seasonalCue: "Summer orchard ladder cycle",
              at: "5:30 PM",
            },
          ],
        },
        {
          id: "dm-3",
          household: "Stonefield Home",
          animal: "deer",
          unread: 0,
          status: "complete",
          lastAt: "1h ago",
          lastMessage: "Milking and butchery handoff finalized for autumn lane.",
          moduleParticipation: [],
          thread: [
            {
              id: "dm-3-msg-1",
              from: "other",
              body: "Milking and butchery handoff finalized for autumn lane.",
              moduleKey: "animals",
              seasonalCue: "Autumn husbandry readiness",
              at: "4:49 PM",
            },
          ],
        },
      ],
      selectedConversationId: "dm-1",
      taskAssignments: [],
      moduleNotifications: [],
      lastUpdatedAt: null,
    };
  }

  const listeners = new Map();
  const eventBus = {
    on: vi.fn((topic, handler) => {
      const items = listeners.get(topic) || [];
      items.push(handler);
      listeners.set(topic, items);
      return () => {
        const current = listeners.get(topic) || [];
        listeners.set(
          topic,
          current.filter((item) => item !== handler)
        );
      };
    }),
    emit: vi.fn((topic, payload) => {
      const items = listeners.get(topic) || [];
      items.forEach((handler) => handler(payload));
      return true;
    }),
    __reset() {
      listeners.clear();
      this.on.mockClear();
      this.emit.mockClear();
    },
  };

  return {
    profileServiceMock: {
      loadProfile: vi.fn(),
      loadDirectMessaging: vi.fn(),
      patchDirectMessaging: vi.fn(),
      appendDirectMessage: vi.fn(),
      subscribe: vi.fn(),
      patchProfile: vi.fn(),
    },
    eventBusMock: eventBus,
    getDirectMessagingFixture: directMessagingFixture,
  };
});

vi.mock("@/services/events/eventBus", () => ({
  default: eventBusMock,
}));

vi.mock("@/services/profile/householdProfileService", () => ({
  ...profileServiceMock,
}));

import ProfileSettingsPage from "../src/pages/settings/ProfileSettingsPage.jsx";

function findButtonByText(container, text) {
  return Array.from(container.querySelectorAll("button")).find((node) =>
    String(node.textContent || "").includes(text)
  );
}

function findConversationButton(container, household) {
  return container.querySelector(`button[aria-label="Open conversation: ${household}"]`);
}

describe("profile settings direct messaging contract", () => {
  let container;
  let root;

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();

    eventBusMock.__reset();

    profileServiceMock.loadProfile.mockReset();
    profileServiceMock.loadDirectMessaging.mockReset();
    profileServiceMock.patchDirectMessaging.mockReset();
    profileServiceMock.appendDirectMessage.mockReset();
    profileServiceMock.subscribe.mockReset();
    profileServiceMock.patchProfile.mockReset();

    const dmFixture = getDirectMessagingFixture();

    profileServiceMock.loadProfile.mockReturnValue({
      household: {},
      notifications: {},
      directMessaging: dmFixture,
    });
    profileServiceMock.loadDirectMessaging.mockResolvedValue(JSON.parse(JSON.stringify(dmFixture)));
    profileServiceMock.patchDirectMessaging.mockImplementation(async (next) => ({
      ok: true,
      messages: next,
    }));
    profileServiceMock.appendDirectMessage.mockResolvedValue({ ok: true });
    profileServiceMock.subscribe.mockImplementation(() => () => {});

    globalThis.history.replaceState({}, "", "/settings");

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      vi.runOnlyPendingTimers();
    });

    if (root) {
      await act(async () => {
        root.unmount();
      });
    }

    vi.useRealTimers();
    globalThis.history.replaceState({}, "", "/settings");
    container?.remove();
    container = null;
    root = null;
    globalThis.IS_REACT_ACT_ENVIRONMENT = false;
  });

  it("applies deep-link query params to open thread context", async () => {
    globalThis.history.replaceState(
      {},
      "",
      "/settings?dmConversation=dm-2&dmModule=animals&dmAction=assign&dmPrefill=Need%20backup"
    );

    await act(async () => {
      root.render(React.createElement(ProfileSettingsPage, { initialTab: "messages" }));
    });

    const panel = container.querySelector('section[aria-label="Direct messaging panel"]');
    expect(panel).toBeTruthy();
    expect(panel.textContent).toContain("Oak and Hearth Thread");

    const selects = panel.querySelectorAll("select");
    expect(selects[0]?.value).toBe("animals");
    expect(selects[1]?.value).toBe("assign");

    const input = panel.querySelector('input[aria-label="Message input"]');
    expect(input?.value).toBe("Need backup");
  });

  it("opens thread from cross-module event payload", async () => {
    await act(async () => {
      root.render(React.createElement(ProfileSettingsPage, { initialTab: "messages" }));
    });

    await act(async () => {
      eventBusMock.emit("profile/messages/open-thread", {
        conversationId: "dm-3",
        moduleKey: "storehouse",
        actionType: "attach",
        prefill: "Bring preserve counts",
      });
    });

    const panel = container.querySelector('section[aria-label="Direct messaging panel"]');
    expect(panel.textContent).toContain("Stonefield Home Thread");

    const selects = panel.querySelectorAll("select");
    expect(selects[0]?.value).toBe("storehouse");
    expect(selects[1]?.value).toBe("attach");

    const input = panel.querySelector('input[aria-label="Message input"]');
    expect(input?.value).toBe("Bring preserve counts");
  });

  it("persists unread increments and read resets", async () => {
    await act(async () => {
      root.render(React.createElement(ProfileSettingsPage, { initialTab: "messages" }));
    });

    await act(async () => {
      eventBusMock.emit("profile/messages/incoming", {
        conversationId: "dm-2",
        message: {
          id: "dm-2-msg-2",
          from: "other",
          body: "Can you confirm lane owner?",
          moduleKey: "meals",
          seasonalCue: "Spring coordination",
          at: "6:05 PM",
        },
      });
      await Promise.resolve();
    });

    const becameUnread = profileServiceMock.patchDirectMessaging.mock.calls
      .map(([payload]) => payload)
      .find((payload) => payload.conversations?.find((item) => item.id === "dm-2")?.unread === 1);
    expect(Boolean(becameUnread)).toBe(true);

    const oakButton = findConversationButton(container, "Oak and Hearth");
    expect(oakButton).toBeTruthy();

    await act(async () => {
      oakButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const resetUnread = profileServiceMock.patchDirectMessaging.mock.calls
      .map(([payload]) => payload)
      .find((payload) => payload.conversations?.find((item) => item.id === "dm-2")?.unread === 0);
    expect(Boolean(resetUnread)).toBe(true);
  });

  it("keeps failed sends retryable and retries successfully", async () => {
    profileServiceMock.appendDirectMessage
      .mockResolvedValueOnce({ ok: false, error: "offline" })
      .mockResolvedValue({ ok: true });

    await act(async () => {
      root.render(React.createElement(ProfileSettingsPage, { initialTab: "messages" }));
    });

    const panel = container.querySelector('section[aria-label="Direct messaging panel"]');
    const attachButton = findButtonByText(panel, "Attach");
    expect(attachButton).toBeTruthy();

    await act(async () => {
      attachButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const sendButton = findButtonByText(panel, "Send");
    await act(async () => {
      sendButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(panel.textContent).toContain("Failed sends");
    const retryButton = findButtonByText(panel, "Retry:");
    expect(retryButton).toBeTruthy();

    await act(async () => {
      retryButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    await act(async () => {
      sendButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(profileServiceMock.appendDirectMessage).toHaveBeenCalledTimes(2);
    expect(panel.textContent).not.toContain("Failed sends");
  });

  it("persists assign actions as task and notification artifacts", async () => {
    await act(async () => {
      root.render(React.createElement(ProfileSettingsPage, { initialTab: "messages" }));
    });

    const panel = container.querySelector('section[aria-label="Direct messaging panel"]');
    const selects = panel.querySelectorAll("select");
    const attachButton = findButtonByText(panel, "Attach");

    await act(async () => {
      attachButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    await act(async () => {
      selects[1].value = "assign";
      selects[1].dispatchEvent(new Event("change", { bubbles: true }));
    });

    const sendButton = findButtonByText(panel, "Send");
    await act(async () => {
      sendButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const persistedAssign = profileServiceMock.patchDirectMessaging.mock.calls
      .map(([payload]) => payload)
      .find(
        (payload) =>
          Array.isArray(payload.taskAssignments)
          && payload.taskAssignments.length > 0
          && Array.isArray(payload.moduleNotifications)
          && payload.moduleNotifications.length > 0
      );

    expect(Boolean(persistedAssign)).toBe(true);
  });
});
