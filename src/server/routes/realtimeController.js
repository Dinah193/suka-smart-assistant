// C:\Users\larho\suka-smart-assistant\src\server\routes\realtimeController.js
//
// Realtime coordination controller (MVP)
// - signal ingestion
// - suggestion queue lookup/consume
// - report generation/latest lookup

"use strict";

const express = require("express");

const router = express.Router();
const basePath = "/api/realtime";

function toList(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v.map((x) => String(x || "").trim()).filter(Boolean);
  return String(v)
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function hasElevatedRole(roles = []) {
  const set = new Set(roles.map((r) => String(r || "").toLowerCase()));
  return set.has("admin") || set.has("owner") || set.has("family_admin") || set.has("household_admin");
}

function requesterFromReq(req) {
  const authUser = req.user || req.auth || {};
  return {
    userId: authUser.id || authUser.userId || req.headers["x-user-id"] || null,
    homeId: authUser.homeId || authUser.householdId || req.headers["x-home-id"] || null,
    familyId: authUser.familyId || req.headers["x-family-id"] || null,
    roles: toList(authUser.roles || req.headers["x-roles"]),
  };
}

function getCoordinator() {
  try {
    const socketMod = require("../socket.js");
    return socketMod.getRealtimeCoordinator ? socketMod.getRealtimeCoordinator() : null;
  } catch {
    return null;
  }
}

function pickScope(req, requester) {
  const scope = req.query.scope === "family" || req.body?.scope === "family"
    ? "family"
    : "household";

  const requestedScopeId =
    scope === "family"
      ? req.query.familyId || req.body?.familyId || requester.familyId
      : req.query.householdId || req.query.homeId || req.body?.householdId || req.body?.homeId || requester.homeId;

  if (!requestedScopeId) {
    return { error: scope === "family" ? "family_scope_forbidden" : "household_scope_missing" };
  }

  // Block cross-scope reads/writes unless elevated role is present.
  if (!hasElevatedRole(requester.roles)) {
    if (scope === "family" && requester.familyId && String(requestedScopeId) !== String(requester.familyId)) {
      return { error: "forbidden_scope" };
    }
    if (scope === "household" && requester.homeId && String(requestedScopeId) !== String(requester.homeId)) {
      return { error: "forbidden_scope" };
    }
  }

  const scopeId = String(requestedScopeId);

  return { scope, scopeId };
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

router.post("/signals", (req, res) => {
  const c = getCoordinator();
  if (!c) return res.status(503).json({ ok: false, error: "realtime_not_ready" });

  const requester = requesterFromReq(req);
  const scoped = pickScope(req, requester);
  if (scoped.error) return res.status(403).json({ ok: false, error: scoped.error });
  const { scope, scopeId } = scoped;
  const payload = req.body?.signal || req.body || {};

  const out = c.ingest(payload, {
    sourceModule: "http.realtime",
    scope,
    scopeId,
    user: {
      id: requester.userId,
      homeId: requester.homeId || scopeId,
      familyId: requester.familyId || null,
    },
  });

  return res.json({ ok: true, ...out });
});

router.get("/suggestions", (req, res) => {
  const c = getCoordinator();
  if (!c) return res.status(503).json({ ok: false, error: "realtime_not_ready" });

  const requester = requesterFromReq(req);
  const scoped = pickScope(req, requester);
  if (scoped.error) return res.status(403).json({ ok: false, error: scoped.error });
  const { scope, scopeId } = scoped;
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

  const requester = requesterFromReq(req);
  const scoped = pickScope(req, requester);
  if (scoped.error) return res.status(403).json({ ok: false, error: scoped.error });
  const { scope, scopeId } = scoped;
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

  const requester = requesterFromReq(req);
  const scoped = pickScope(req, requester);
  if (scoped.error) return res.status(403).json({ ok: false, error: scoped.error });
  const { scope, scopeId } = scoped;

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
  const requester = requesterFromReq(req);
  const scoped = pickScope(req, requester);
  if (scoped.error) return res.status(403).json({ ok: false, error: scoped.error });
  const { scope, scopeId } = scoped;
  const report = c.getLatestReport({ scope, scopeId });
  return res.json({ ok: true, report });
});

router.get("/reports/latest", (req, res) => {
  const c = getCoordinator();
  if (!c) return res.status(503).json({ ok: false, error: "realtime_not_ready" });

  const requester = requesterFromReq(req);
  const scoped = pickScope(req, requester);
  if (scoped.error) return res.status(403).json({ ok: false, error: scoped.error });
  const { scope, scopeId } = scoped;
  const report = c.getLatestReport({ scope, scopeId });
  return res.json({ ok: true, report: report || null });
});

router.get("/reports/latest.csv", (req, res) => {
  const c = getCoordinator();
  if (!c) return res.status(503).json({ ok: false, error: "realtime_not_ready" });

  const requester = requesterFromReq(req);
  const scoped = pickScope(req, requester);
  if (scoped.error) return res.status(403).json({ ok: false, error: scoped.error });
  const { scope, scopeId } = scoped;
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

  const requester = requesterFromReq(req);
  const scoped = pickScope(req, requester);
  if (scoped.error) return res.status(403).json({ ok: false, error: scoped.error });

  const limit = Number(req.query.limit || 200);
  const items = c.getAuditHistory ? c.getAuditHistory({ limit }) : [];
  return res.json({ ok: true, count: items.length, items });
});

router.get("/signals", (req, res) => {
  const c = getCoordinator();
  if (!c) return res.status(503).json({ ok: false, error: "realtime_not_ready" });

  const requester = requesterFromReq(req);
  const scoped = pickScope(req, requester);
  if (scoped.error) return res.status(403).json({ ok: false, error: scoped.error });

  const limit = Number(req.query.limit || 200);
  const items = c.getSignalHistory ? c.getSignalHistory({ limit }) : [];
  return res.json({ ok: true, count: items.length, items });
});

module.exports = { router, basePath };
