// C:\Users\larho\suka-smart-assistant\src\server\routes\realtimeController.js
//
// Realtime coordination controller (MVP)
// - signal ingestion
// - suggestion queue lookup/consume
// - report generation/latest lookup

"use strict";

const express = require("express");
const { correlationContext } = require("../middleware/realtime/correlationContext.js");
const { authenticateRequest } = require("../middleware/realtime/authenticateRequest.js");
const { authorizeScope } = require("../middleware/realtime/authorizeScope.js");
const { validateRealtimeEnvelope } = require("../middleware/realtime/validateRealtimeEnvelope.js");
const { mapRealtimeErrorMiddleware } = require("../middleware/realtime/mapRealtimeError.js");

const router = express.Router();
const basePath = "/api/realtime";

const realtimeHttpRateWindowMs = Number(process.env.REALTIME_HTTP_RATE_WINDOW_MS || 60_000);
const realtimeHttpRateMax = Number(process.env.REALTIME_HTTP_RATE_MAX || 120);
const realtimeIpBuckets = new Map();

function realtimeRateLimit(req, res, next) {
  const now = Date.now();
  const ip = req.ip || req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "unknown";
  const state = realtimeIpBuckets.get(ip) || { count: 0, resetAt: now + realtimeHttpRateWindowMs };
  if (now >= state.resetAt) {
    state.count = 0;
    state.resetAt = now + realtimeHttpRateWindowMs;
  }
  state.count += 1;
  realtimeIpBuckets.set(ip, state);

  if (state.count > realtimeHttpRateMax) {
    res.setHeader("Retry-After", Math.ceil((state.resetAt - now) / 1000));
    return res.status(429).json({ ok: false, error: "rate_limited" });
  }
  return next();
}

function getCoordinator() {
  try {
    const socketMod = require("../socket.js");
    return socketMod.getRealtimeCoordinator ? socketMod.getRealtimeCoordinator() : null;
  } catch {
    return null;
  }
}

function maybeAppendSignal(c, payload, context) {
  if (!c?.shouldAppendSignals || !c?.appendSignal) return { ok: true, skipped: true };
  if (!c.shouldAppendSignals()) return { ok: true, skipped: true };
  return c.appendSignal(payload, context);
}

function asCsv(report) {
  const rows = [
    ["metric", "value"],
    ["scope", report?.scope || ""],
    ["scopeId", report?.scopeId || ""],
    ["generatedAt", report?.generatedAt || ""],
    ["signals24h", report?.summary?.signals24h ?? 0],
    ["pendingSuggestions", report?.summary?.pendingSuggestions ?? 0],
    ["completedSuggestions", report?.summary?.completedSuggestions ?? 0],
    ["highPriorityPending", report?.summary?.highPriorityPending ?? 0],
    ["assignedPending", report?.summary?.assignedPending ?? 0],
    ["unassignedPending", report?.summary?.unassignedPending ?? 0],
  ];
  const breakdown = report?.signalBreakdown || {};
  for (const [k, v] of Object.entries(breakdown)) {
    rows.push([`signal.${k}`, v]);
  }
  return rows
    .map((r) => r.map((cell) => `"${String(cell ?? "").replace(/"/g, '""')}"`).join(","))
    .join("\n");
}

router.get("/health", (req, res) => {
  const c = getCoordinator();
  res.json({
    ok: true,
    coordinatorReady: !!c,
    state: c?.getState ? c.getState() : null,
  });
});

// Deterministic realtime middleware ordering for all non-health routes.
router.use(realtimeRateLimit, correlationContext, authenticateRequest, authorizeScope, validateRealtimeEnvelope);

router.post("/signals", (req, res) => {
  const c = getCoordinator();
  if (!c) return res.status(503).json({ ok: false, error: "realtime_not_ready" });

  const requester = req.realtime?.requester || {};
  const scope = req.realtime?.scope;
  const scopeId = req.realtime?.scopeId;
  const payload = req.realtime?.envelope || req.body?.signal || req.body || {};
  const ingestContext = {
    sourceModule: "http.realtime",
    scope,
    scopeId,
    user: {
      id: requester.userId,
      homeId: requester.homeId || scopeId,
      familyId: requester.familyId || null,
    },
  };

  try {
    const appended = maybeAppendSignal(c, payload, ingestContext);
    if (!appended?.ok) {
      return res.status(503).json({
        ok: false,
        error: appended.error || "event_log_unavailable",
        reason: appended.reason || "append_failed",
      });
    }

    const out = c.ingest(payload, {
      ...ingestContext,
      _alreadyAppended: !appended?.skipped,
    });

    if (out?.ok === false) {
      const status = out.error === "duplicate_event" ? 409 : 400;
      return res.status(status).json({
        ok: false,
        error: out.error || "invalid_event",
        reason: out.reason || null,
      });
    }

    return res.json(out);
  } catch {
    return res.status(400).json({ ok: false, error: "invalid_event", reason: "ingest_failed" });
  }
});

router.get("/suggestions", (req, res) => {
  const c = getCoordinator();
  if (!c) return res.status(503).json({ ok: false, error: "realtime_not_ready" });

  const scope = req.realtime?.scope;
  const scopeId = req.realtime?.scopeId;
  const includeConsumed = String(req.query.includeConsumed || "false").toLowerCase() === "true";
  const items = c.listSuggestions({
    scope,
    scopeId,
    includeConsumed,
    target: req.query.target,
    domain: req.query.domain,
    assignedToUserId: req.query.assignedToUserId,
  });
  return res.json({ ok: true, scope, scopeId, count: items.length, items, suggestions: items });
});

router.post("/suggestions/:id/consume", (req, res) => {
  const c = getCoordinator();
  if (!c) return res.status(503).json({ ok: false, error: "realtime_not_ready" });

  const requester = req.realtime?.requester || {};
  const scope = req.realtime?.scope;
  const scopeId = req.realtime?.scopeId;

  const item = c.consumeSuggestion({
    scope,
    scopeId,
    suggestionId: req.params.id,
    userId: requester.userId || req.body?.userId || null,
  });

  if (!item) return res.status(404).json({ ok: false, error: "suggestion_not_found" });
  return res.json({ ok: true, item, suggestion: item });
});

router.post("/suggestions/:id/assign", (req, res) => {
  const c = getCoordinator();
  if (!c) return res.status(503).json({ ok: false, error: "realtime_not_ready" });

  const requester = req.realtime?.requester || {};
  const scope = req.realtime?.scope;
  const scopeId = req.realtime?.scopeId;

  const item = c.assignSuggestion({
    scope,
    scopeId,
    suggestionId: req.params.id,
    assignedToUserId: req.body?.assignedToUserId || null,
    assignedRole: req.body?.assignedRole || null,
    assignedBy: requester.userId || null,
  });

  if (!item) return res.status(404).json({ ok: false, error: "suggestion_not_found" });
  return res.json({ ok: true, item, suggestion: item });
});

router.post("/reports/generate", (req, res) => {
  const c = getCoordinator();
  if (!c) return res.status(503).json({ ok: false, error: "realtime_not_ready" });

  c.generateReports();
  const scope = req.realtime?.scope;
  const scopeId = req.realtime?.scopeId;
  const report = c.getLatestReport({ scope, scopeId });
  return res.json({ ok: true, report });
});

router.get("/reports/latest", (req, res) => {
  const c = getCoordinator();
  if (!c) return res.status(503).json({ ok: false, error: "realtime_not_ready" });

  const scope = req.realtime?.scope;
  const scopeId = req.realtime?.scopeId;
  const report = c.getLatestReport({ scope, scopeId });
  return res.json({ ok: true, report: report || null });
});

router.get("/reports/latest.csv", (req, res) => {
  const c = getCoordinator();
  if (!c) return res.status(503).json({ ok: false, error: "realtime_not_ready" });

  const scope = req.realtime?.scope;
  const scopeId = req.realtime?.scopeId;
  const report = c.getLatestReport({ scope, scopeId });
  if (!report) return res.status(404).json({ ok: false, error: "report_not_found" });

  const csv = asCsv(report);
  const filename = `realtime-report-${scope}-${scopeId}.csv`;
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename=\"${filename}\"`);
  return res.status(200).send(csv);
});

router.get("/audit", (req, res) => {
  const c = getCoordinator();
  if (!c) return res.status(503).json({ ok: false, error: "realtime_not_ready" });

  const limit = Number(req.query.limit || 200);
  const items = c.getAuditHistory ? c.getAuditHistory({ limit }) : [];
  return res.json({ ok: true, count: items.length, items });
});

router.get("/signals", (req, res) => {
  const c = getCoordinator();
  if (!c) return res.status(503).json({ ok: false, error: "realtime_not_ready" });

  const limit = Number(req.query.limit || 200);
  const items = c.getSignalHistory ? c.getSignalHistory({ limit }) : [];
  return res.json({ ok: true, count: items.length, items });
});

router.get("/diagnostics", (req, res) => {
  const c = getCoordinator();
  if (!c) return res.status(503).json({ ok: false, error: "realtime_not_ready" });

  const scope = req.realtime?.scope;
  const scopeId = req.realtime?.scopeId;

  const diagnostics = c.getDiagnostics
    ? c.getDiagnostics({ scope, scopeId })
    : { state: c.getState ? c.getState() : null };

  return res.json({ ok: true, scope, scopeId, diagnostics });
});

router.use(mapRealtimeErrorMiddleware);

module.exports = { router, basePath };
