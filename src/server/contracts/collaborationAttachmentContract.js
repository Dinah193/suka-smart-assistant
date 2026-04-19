"use strict";

const ALLOWED_TYPES = new Set(["image", "document", "audio", "video", "link"]);
const ALLOWED_VISIBILITY = new Set(["household", "moderator", "public"]);

function sanitizeString(value) {
  return String(value || "").trim();
}

function resolveAttachmentVisibility({ role, requestedVisibility }) {
  const requested = sanitizeString(requestedVisibility).toLowerCase() || "household";
  const actorRole = sanitizeString(role).toLowerCase() || "member";

  if (!ALLOWED_VISIBILITY.has(requested)) {
    return actorRole === "admin" || actorRole === "moderator" ? "moderator" : "household";
  }

  if (requested === "public" && actorRole !== "admin" && actorRole !== "moderator") {
    return "household";
  }

  if (requested === "moderator" && actorRole === "guest") {
    return "household";
  }

  return requested;
}

function validateAttachmentPayload(payload = {}) {
  const type = sanitizeString(payload.type).toLowerCase();
  const url = sanitizeString(payload.url);
  const name = sanitizeString(payload.name);
  const sizeBytes = Number(payload.sizeBytes || 0);

  if (!ALLOWED_TYPES.has(type)) {
    return {
      ok: false,
      code: "attachment_invalid_type",
      message: "Attachment type is not allowed.",
      retryable: false,
      details: { allowed: Array.from(ALLOWED_TYPES), received: type || null },
    };
  }

  if (!url || !/^https?:\/\//i.test(url)) {
    return {
      ok: false,
      code: "attachment_invalid_url",
      message: "Attachment URL must be an absolute HTTP(S) URL.",
      retryable: false,
      details: { url: url || null },
    };
  }

  if (!name) {
    return {
      ok: false,
      code: "attachment_missing_name",
      message: "Attachment name is required.",
      retryable: false,
      details: { field: "name" },
    };
  }

  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0 || sizeBytes > 50 * 1024 * 1024) {
    return {
      ok: false,
      code: "attachment_invalid_size",
      message: "Attachment size is invalid.",
      retryable: false,
      details: { min: 1, max: 50 * 1024 * 1024, received: sizeBytes },
    };
  }

  return {
    ok: true,
    attachment: {
      type,
      url,
      name,
      sizeBytes,
      safetyStatus: "pending_scan",
    },
  };
}

module.exports = {
  ALLOWED_TYPES,
  ALLOWED_VISIBILITY,
  resolveAttachmentVisibility,
  validateAttachmentPayload,
};
