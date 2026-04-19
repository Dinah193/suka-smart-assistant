import { describe, expect, it } from "vitest";

const {
  resolveAttachmentVisibility,
  validateAttachmentPayload,
} = require("../src/server/contracts/collaborationAttachmentContract.js");

describe("collaboration attachments contract", () => {
  it("rejects invalid payloads deterministically", () => {
    const invalidType = validateAttachmentPayload({
      type: "archive",
      url: "https://example.test/file.zip",
      name: "file.zip",
      sizeBytes: 128,
    });
    expect(invalidType.ok).toBe(false);
    expect(invalidType.code).toBe("attachment_invalid_type");
    expect(invalidType.retryable).toBe(false);

    const invalidUrl = validateAttachmentPayload({
      type: "document",
      url: "not-a-url",
      name: "doc.pdf",
      sizeBytes: 128,
    });
    expect(invalidUrl.ok).toBe(false);
    expect(invalidUrl.code).toBe("attachment_invalid_url");

    const invalidSize = validateAttachmentPayload({
      type: "image",
      url: "https://example.test/pic.jpg",
      name: "pic.jpg",
      sizeBytes: 0,
    });
    expect(invalidSize.ok).toBe(false);
    expect(invalidSize.code).toBe("attachment_invalid_size");
  });

  it("applies deterministic visibility rules by role", () => {
    const memberPublic = resolveAttachmentVisibility({
      role: "member",
      requestedVisibility: "public",
    });
    expect(memberPublic).toBe("household");

    const moderatorPublic = resolveAttachmentVisibility({
      role: "moderator",
      requestedVisibility: "public",
    });
    expect(moderatorPublic).toBe("public");

    const guestModerator = resolveAttachmentVisibility({
      role: "guest",
      requestedVisibility: "moderator",
    });
    expect(guestModerator).toBe("household");
  });
});
