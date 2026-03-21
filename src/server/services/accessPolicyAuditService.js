"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { redactObject } = require("./loggingSanitizer.js");

const AUDIT_FILE = path.resolve(
  process.cwd(),
  String(process.env.ACCESS_POLICY_AUDIT_FILE || "data/access-policy-audit.json")
);
const AUDIT_ROLLOVER_FILE = path.resolve(
  process.cwd(),
  String(process.env.ACCESS_POLICY_AUDIT_ROLLOVER_FILE || "data/access-policy-audit-rollover.ndjson")
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

function asBoolean(value, fallback) {
  if (typeof value === "boolean") return value;
  const normalized = String(value ?? "").trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function asPositiveInteger(value, fallback, floor = 1) {
  const n = Math.floor(asNumber(value, fallback));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(floor, n);
}

async function appendRolloverEvents(entries = []) {
  if (!Array.isArray(entries) || entries.length < 1) return 0;
  await ensureDataDir();
  await fs.mkdir(path.dirname(AUDIT_ROLLOVER_FILE), { recursive: true });
  const payload = entries.map((row) => JSON.stringify(row)).join("\n") + "\n";
  await fs.appendFile(AUDIT_ROLLOVER_FILE, payload, "utf8");
  return entries.length;
}

function applyRetentionRules(store, {
  nowMs = Date.now(),
  maxEvents = process.env.ACCESS_POLICY_AUDIT_MAX_EVENTS,
  retentionMs = process.env.ACCESS_POLICY_AUDIT_RETENTION_MS,
} = {}) {
  const items = Array.isArray(store?.events) ? store.events.slice() : [];
  const hasExplicitMaxEvents = maxEvents !== undefined && maxEvents !== null && String(maxEvents).trim() !== "";
  const safeMaxEvents = hasExplicitMaxEvents
    ? asPositiveInteger(maxEvents, 5000, 1)
    : asPositiveInteger(maxEvents, 5000, 500);
  const safeRetentionMs = Math.max(60_000, asNumber(retentionMs, 30 * 24 * 60 * 60 * 1000));
  const floorMs = nowMs - safeRetentionMs;

  const kept = [];
  const pruned = [];
  for (const evt of items) {
    const atMs = parseIsoToMs(evt?.at);
    if (atMs != null && atMs < floorMs) {
      pruned.push({ reason: "retention_age", event: evt });
      continue;
    }
    kept.push(evt);
  }

  if (kept.length > safeMaxEvents) {
    const overflow = kept.length - safeMaxEvents;
    const overflowItems = kept.slice(0, overflow);
    for (const evt of overflowItems) {
      pruned.push({ reason: "max_events", event: evt });
    }
    kept.splice(0, overflow);
  }

  return {
    kept,
    pruned,
    config: {
      maxEvents: safeMaxEvents,
      retentionMs: safeRetentionMs,
    },
  };
}

async function applyAuditMaintenance(store, {
  nowMs = Date.now(),
  maxEvents = process.env.ACCESS_POLICY_AUDIT_MAX_EVENTS,
  retentionMs = process.env.ACCESS_POLICY_AUDIT_RETENTION_MS,
  rolloverEnabled = process.env.ACCESS_POLICY_AUDIT_ROLLOVER_ENABLED,
} = {}) {
  const retention = applyRetentionRules(store, { nowMs, maxEvents, retentionMs });
  const nextStore = {
    ...defaultStore(),
    ...(store && typeof store === "object" ? store : {}),
    events: retention.kept,
  };

  const shouldRollover = asBoolean(rolloverEnabled, true);
  const rolledAt = nowIso();
  let rolledCount = 0;
  if (shouldRollover && retention.pruned.length > 0) {
    rolledCount = await appendRolloverEvents(
      retention.pruned.map((entry) => ({
        rolledAt,
        reason: entry.reason,
        event: entry.event,
      }))
    );
  }

  const prunedByReason = retention.pruned.reduce((acc, row) => {
    const key = String(row?.reason || "unknown");
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});

  return {
    nextStore,
    result: {
      ok: true,
      config: {
        ...retention.config,
        rolloverEnabled: shouldRollover,
      },
      totalBefore: Array.isArray(store?.events) ? store.events.length : 0,
      totalAfter: retention.kept.length,
      prunedCount: retention.pruned.length,
      rolledCount,
      prunedByReason,
    },
  };
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

  const maintenance = await applyAuditMaintenance(store);
  await writeAuditStore(maintenance.nextStore);
  return event;
}

async function runAuditMaintenance(options = {}) {
  const store = await readAuditStore();
  const maintenance = await applyAuditMaintenance(store, options);
  await writeAuditStore(maintenance.nextStore);
  return maintenance.result;
}

function parseIsoToMs(input) {
  const ms = Date.parse(String(input || ""));
  if (!Number.isFinite(ms)) return null;
  return ms;
}

function parseCsvSet(raw) {
  return new Set(
    String(raw || "")
      .split(",")
      .map((x) => String(x || "").trim())
      .filter(Boolean)
  );
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

async function summarizeAuditEvents({ windowMs = 24 * 60 * 60 * 1000 } = {}) {
  const store = await readAuditStore();
  const safeWindowMs = Math.max(60_000, asNumber(windowMs, 24 * 60 * 60 * 1000));
  const floorMs = Date.now() - safeWindowMs;
  const items = Array.isArray(store.events) ? store.events.slice() : [];

  const countsByAction = {};
  let failuresInWindow = 0;
  let totalInWindow = 0;

  for (const evt of items) {
    const action = String(evt?.action || "unknown");
    countsByAction[action] = (countsByAction[action] || 0) + 1;

    const atMs = parseIsoToMs(evt?.at) || 0;
    if (atMs >= floorMs) {
      totalInWindow += 1;
      if (evt?.ok === false) {
        failuresInWindow += 1;
      }
    }
  }

  return {
    ok: true,
    windowMs: safeWindowMs,
    totalEvents: items.length,
    totalInWindow,
    failuresInWindow,
    countsByAction,
  };
}

async function listAuditAlerts({
  windowMs = 60 * 60 * 1000,
  failureRateThreshold = process.env.ACCESS_POLICY_AUDIT_ALERT_FAILURE_RATE_THRESHOLD,
  minEvents = process.env.ACCESS_POLICY_AUDIT_ALERT_MIN_EVENTS,
  highRiskActionThreshold = process.env.ACCESS_POLICY_AUDIT_ALERT_HIGH_RISK_ACTION_THRESHOLD,
  highRiskActions = process.env.ACCESS_POLICY_AUDIT_ALERT_HIGH_RISK_ACTIONS,
} = {}) {
  const summary = await summarizeAuditEvents({ windowMs });
  const thresholdRate = Math.max(0, Math.min(1, Number(failureRateThreshold ?? 0.25)));
  const thresholdMinEvents = Math.max(1, asNumber(minEvents, 10));
  const thresholdHighRisk = Math.max(1, asNumber(highRiskActionThreshold, 5));
  const highRiskSet = parseCsvSet(
    highRiskActions || "entitlement.set,collaboration_grant.delete,collaboration_grant.upsert"
  );

  const alerts = [];
  const failureRate = summary.totalInWindow > 0 ? summary.failuresInWindow / summary.totalInWindow : 0;
  if (summary.totalInWindow >= thresholdMinEvents && failureRate >= thresholdRate) {
    alerts.push({
      id: "failure_rate_exceeded",
      severity: "warn",
      message: "Audit failure rate exceeded configured threshold",
      metric: {
        failureRate,
        failuresInWindow: summary.failuresInWindow,
        totalInWindow: summary.totalInWindow,
      },
      threshold: {
        failureRateThreshold: thresholdRate,
        minEvents: thresholdMinEvents,
      },
    });
  }

  for (const [action, count] of Object.entries(summary.countsByAction || {})) {
    if (!highRiskSet.has(action)) continue;
    if (Number(count || 0) < thresholdHighRisk) continue;
    alerts.push({
      id: `high_risk_action_spike:${action}`,
      severity: "warn",
      message: "High-risk action volume exceeded configured threshold",
      metric: { action, count: Number(count || 0) },
      threshold: { highRiskActionThreshold: thresholdHighRisk },
    });
  }

  return {
    ok: true,
    windowMs: summary.windowMs,
    alerts,
    summary,
  };
}

module.exports = {
  appendAuditEvent,
  listAuditEvents,
  listAuditAlerts,
  runAuditMaintenance,
  summarizeAuditEvents,
};
