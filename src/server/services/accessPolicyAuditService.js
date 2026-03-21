"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { redactObject } = require("./loggingSanitizer.js");

const AUDIT_FILE = path.resolve(
  process.cwd(),
  String(process.env.ACCESS_POLICY_AUDIT_FILE || "data/access-policy-audit.json")
);

function nowIso() {
  return new Date().toISOString();
}

function defaultStore() {
  return {
    version: 1,
    events: [],
    updatedAt: nowIso(),
  };
}

async function ensureDataDir() {
  await fs.mkdir(path.dirname(AUDIT_FILE), { recursive: true });
}

async function readAuditStore() {
  await ensureDataDir();
  try {
    const raw = await fs.readFile(AUDIT_FILE, "utf8");
    const parsed = JSON.parse(raw || "{}");
    return {
      ...defaultStore(),
      ...parsed,
      events: Array.isArray(parsed?.events) ? parsed.events : [],
    };
  } catch {
    return defaultStore();
  }
}

async function writeAuditStore(nextStore) {
  await ensureDataDir();
  const payload = {
    ...defaultStore(),
    ...(nextStore && typeof nextStore === "object" ? nextStore : {}),
    events: Array.isArray(nextStore?.events) ? nextStore.events : [],
    updatedAt: nowIso(),
  };
  await fs.writeFile(AUDIT_FILE, JSON.stringify(payload, null, 2), "utf8");
  return payload;
}

function asNumber(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return n;
}

async function appendAuditEvent({
  type = "access_policy_admin",
  action = "unknown",
  actorUserId = "unknown",
  requestId = null,
  ok = true,
  details = {},
  at = nowIso(),
} = {}) {
  const store = await readAuditStore();
  const event = {
    id: `audit_${crypto.randomUUID()}`,
    type: String(type || "access_policy_admin"),
    action: String(action || "unknown"),
    actorUserId: String(actorUserId || "unknown"),
    requestId: requestId == null ? null : String(requestId),
    ok: Boolean(ok),
    at: String(at || nowIso()),
    details: redactObject(details && typeof details === "object" ? details : {}),
  };
  store.events.push(event);

  const maxEvents = Math.max(500, asNumber(process.env.ACCESS_POLICY_AUDIT_MAX_EVENTS, 5000));
  if (store.events.length > maxEvents) {
    store.events = store.events.slice(store.events.length - maxEvents);
  }

  await writeAuditStore(store);
  return event;
}

function parseIsoToMs(input) {
  const ms = Date.parse(String(input || ""));
  if (!Number.isFinite(ms)) return null;
  return ms;
}

async function listAuditEvents({ action, actorUserId, since, limit = 100 } = {}) {
  const store = await readAuditStore();
  const normalizedAction = String(action || "").trim();
  const normalizedActor = String(actorUserId || "").trim();
  const sinceMs = parseIsoToMs(since);
  const maxLimit = Math.max(1, Math.min(500, asNumber(limit, 100)));

  let items = Array.isArray(store.events) ? store.events.slice() : [];

  if (normalizedAction) {
    items = items.filter((evt) => String(evt?.action || "") === normalizedAction);
  }
  if (normalizedActor) {
    items = items.filter((evt) => String(evt?.actorUserId || "") === normalizedActor);
  }
  if (sinceMs != null) {
    items = items.filter((evt) => {
      const at = parseIsoToMs(evt?.at);
      return at != null && at >= sinceMs;
    });
  }

  items.sort((a, b) => {
    const aMs = parseIsoToMs(a?.at) || 0;
    const bMs = parseIsoToMs(b?.at) || 0;
    return bMs - aMs;
  });

  return {
    ok: true,
    count: items.length,
    items: items.slice(0, maxLimit),
  };
}

module.exports = {
  appendAuditEvent,
  listAuditEvents,
};
