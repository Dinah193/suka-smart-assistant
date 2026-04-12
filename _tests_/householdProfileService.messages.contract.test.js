// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appendDirectMessage,
  loadDirectMessaging,
  patchDirectMessaging,
  resetToDefaults,
  selectDirectMessaging,
} from "../src/services/profile/householdProfileService.js";

describe("household profile direct messaging contract", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    localStorage.clear();
    resetToDefaults();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("loads direct messaging from backend contract and persists into profile cache", async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        ok: true,
        householdId: "default-household",
        messages: {
          conversations: [
            {
              id: "dm-contract-1",
              household: "Willow Collective",
              thread: [{ id: "m1", from: "other", body: "sync?", moduleKey: "meals", seasonalCue: "spring", at: "7:10 PM" }],
              unread: 1,
              status: "request",
              lastMessage: "sync?",
              lastAt: "now",
              moduleParticipation: [],
            },
          ],
          selectedConversationId: "dm-contract-1",
        },
      }),
    }));

    const loaded = await loadDirectMessaging();
    const selected = selectDirectMessaging();

    expect(loaded.selectedConversationId).toBe("dm-contract-1");
    expect(selected.conversations[0].id).toBe("dm-contract-1");
    expect(selected.conversations[0].thread[0].body).toBe("sync?");
  });

  it("saves patched direct messaging via backend and keeps local state updated", async () => {
    globalThis.fetch = vi.fn(async (_url, init) => ({
      ok: true,
      json: async () => ({
        ok: true,
        init,
      }),
    }));

    const result = await patchDirectMessaging({
      conversations: [
        {
          id: "dm-save-1",
          household: "Oak and Hearth",
          thread: [],
          unread: 0,
          status: "assigned",
          lastMessage: "",
          lastAt: "",
          moduleParticipation: [],
        },
      ],
      selectedConversationId: "dm-save-1",
      taskAssignments: [
        {
          id: "task-1",
          conversationId: "dm-save-1",
          moduleKey: "meals",
          title: "Assign lane owner",
        },
      ],
      moduleNotifications: [
        {
          id: "notif-1",
          conversationId: "dm-save-1",
          moduleKey: "meals",
          message: "Assigned task: Assign lane owner",
          unread: true,
        },
      ],
    });

    const selected = selectDirectMessaging();
    expect(result.ok).toBe(true);
    expect(selected.selectedConversationId).toBe("dm-save-1");
    expect(selected.conversations[0].household).toBe("Oak and Hearth");
    expect(selected.taskAssignments[0].title).toBe("Assign lane owner");
    expect(selected.moduleNotifications[0].unread).toBe(true);

    const call = globalThis.fetch.mock.calls.find(([url]) => String(url).includes("/api/planners/profile/messages"));
    expect(call).toBeTruthy();
  });

  it("appends message via backend append contract and updates selected thread", async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        ok: true,
        householdId: "default-household",
        messages: {
          conversations: [
            {
              id: "dm-append-1",
              household: "Stonefield Home",
              thread: [
                { id: "m1", from: "me", body: "initial", moduleKey: "animals", seasonalCue: "autumn", at: "6:01 PM" },
                { id: "m2", from: "me", body: "follow-up", moduleKey: "animals", seasonalCue: "autumn", at: "6:02 PM" },
              ],
              unread: 0,
              status: "assigned",
              lastMessage: "follow-up",
              lastAt: "now",
              moduleParticipation: [],
            },
          ],
          selectedConversationId: "dm-append-1",
        },
      }),
    }));

    const appended = await appendDirectMessage({
      conversationId: "dm-append-1",
      message: {
        from: "me",
        body: "follow-up",
        moduleKey: "animals",
        seasonalCue: "autumn",
      },
    });

    const selected = selectDirectMessaging();
    expect(appended.ok).toBe(true);
    expect(selected.conversations[0].thread.length).toBe(2);
    expect(selected.conversations[0].lastMessage).toBe("follow-up");
  });
});
