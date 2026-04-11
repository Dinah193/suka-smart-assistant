"use strict";

const {
  NOTIFICATION_EVENT_SEVERITY,
  NOTIFICATION_EVENT_TYPES,
} = require("../../contracts/householdSocialContract.js");

const HOUSEHOLD_NOTIFICATION_LIMIT = 500;

function normalizeText(value, fallback = "") {
  return String(value == null ? fallback : value).trim();
}

function normalizeHandle(value) {
  return normalizeText(value).toLowerCase();
}

function resolveEventConfig(eventType) {
  const key = normalizeText(eventType);
  if (!key) return null;

  if (NOTIFICATION_EVENT_TYPES[key]) {
    return NOTIFICATION_EVENT_TYPES[key];
  }

  const byActionKey = Object.values(NOTIFICATION_EVENT_TYPES).find(
    (entry) => normalizeText(entry?.key) === key
  );
  return byActionKey || null;
}

function buildNotificationEntry({
  idFactory,
  eventType,
  createdAt,
  type = "system",
  title,
  message,
  module = "community",
  sourceModule = null,
  sourceId = null,
  commentId = null,
  mention = null,
  profileHref = null,
  metadata = {},
}) {
  const eventConfig = resolveEventConfig(eventType);

  return {
    id: idFactory("community-notification"),
    type: normalizeText(type || "system") || "system",
    eventType: eventConfig?.key || normalizeText(eventType) || null,
    severity: eventConfig?.severity || NOTIFICATION_EVENT_SEVERITY.INFORMATIONAL,
    title: normalizeText(title),
    message: normalizeText(message),
    module: normalizeText(module || "community") || "community",
    sourceModule: sourceModule ? normalizeText(sourceModule) : null,
    sourceId: sourceId ? normalizeText(sourceId) : null,
    commentId: commentId ? normalizeText(commentId) : null,
    mention: mention ? normalizeHandle(mention) : null,
    profileHref: profileHref ? normalizeText(profileHref) : null,
    metadata: metadata && typeof metadata === "object" ? metadata : {},
    createdAt: normalizeText(createdAt || new Date().toISOString()),
    read: false,
  };
}

function appendHouseholdNotifications({ householdState, entries, nowIso }) {
  const existing = Array.isArray(householdState?.notifications)
    ? householdState.notifications
    : [];
  const incoming = Array.isArray(entries) ? entries.filter(Boolean) : [];
  householdState.notifications = [...incoming, ...existing].slice(
    0,
    HOUSEHOLD_NOTIFICATION_LIMIT
  );
  householdState.updatedAt = normalizeText(nowIso || new Date().toISOString());
  return householdState.notifications;
}

function buildMentionNotificationEntries({
  moduleKey,
  sourceId,
  comment,
  actor,
  nowIso,
  idFactory,
  profileHrefBuilder,
}) {
  const mentions = Array.isArray(comment?.mentions) ? comment.mentions : [];
  const uniqueMentions = Array.from(
    new Set(mentions.map((value) => normalizeHandle(value)).filter(Boolean))
  );
  if (!uniqueMentions.length) return [];

  const snippet = normalizeText(comment?.body).slice(0, 140);
  const by = normalizeText(actor || comment?.author || "household-user");

  return uniqueMentions.map((handle) =>
    buildNotificationEntry({
      idFactory,
      eventType: "FEED_MENTIONED",
      createdAt: nowIso,
      type: "mention",
      title: `@${handle} mentioned in ${moduleKey} thread`,
      message: snippet
        ? `${by} mentioned @${handle}: "${snippet}"`
        : `${by} mentioned @${handle} in a ${moduleKey} thread.`,
      module: "community",
      sourceModule: moduleKey,
      sourceId,
      commentId: comment?.id,
      mention: handle,
      profileHref: profileHrefBuilder(handle),
      metadata: {
        channel: "feed-thread",
      },
    })
  );
}

module.exports = {
  appendHouseholdNotifications,
  buildMentionNotificationEntries,
  buildNotificationEntry,
};
