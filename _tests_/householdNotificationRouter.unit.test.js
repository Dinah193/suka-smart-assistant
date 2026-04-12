import { describe, expect, it } from "vitest";

const {
  appendHouseholdNotifications,
  buildMentionNotificationEntries,
  buildNotificationEntry,
} = require("../src/server/services/planners/HouseholdNotificationRouter.js");

describe("household notification router", () => {
  it("builds mention notifications with contract event metadata", () => {
    const nowIso = "2026-04-11T12:00:00.000Z";
    const entries = buildMentionNotificationEntries({
      moduleKey: "meal",
      sourceId: "meal-feed-1",
      comment: {
        id: "comment-1",
        body: "Looping in @Willow for follow-up",
        mentions: ["Willow"],
      },
      actor: "planner-user",
      nowIso,
      idFactory: (prefix) => `${prefix}-1`,
      profileHrefBuilder: (handle) => `/settings/profile?handle=${encodeURIComponent(handle)}`,
    });

    expect(entries.length).toBe(1);
    expect(entries[0]).toMatchObject({
      type: "mention",
      eventType: "feed.mentioned",
      severity: "action_required",
      sourceModule: "meal",
      sourceId: "meal-feed-1",
      mention: "willow",
      createdAt: nowIso,
    });
  });

  it("prepends notifications while preserving household cap", () => {
    const householdState = {
      notifications: Array.from({ length: 501 }, (_, index) => ({ id: `existing-${index}` })),
    };

    const entry = buildNotificationEntry({
      idFactory: (prefix) => `${prefix}-new`,
      eventType: "APPROVAL_REQUESTED",
      createdAt: "2026-04-11T12:00:00.000Z",
      title: "Approval requested",
      message: "Review this approval request.",
      module: "community",
    });

    const next = appendHouseholdNotifications({
      householdState,
      entries: [entry],
      nowIso: "2026-04-11T12:00:00.000Z",
    });

    expect(next.length).toBe(500);
    expect(next[0].id).toBe("community-notification-new");
    expect(next[0].eventType).toBe("approval.requested");
    expect(next[0].severity).toBe("action_required");
  });
});
