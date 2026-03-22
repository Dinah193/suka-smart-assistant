"use strict";

const express = require("express");
const { authenticateRequest } = require("../middleware/realtime/authenticateRequest.js");
const { redactObject } = require("../services/loggingSanitizer.js");
const {
  appendAuditEvent,
  listAuditAnomalies,
  listAuditAlerts,
  listAuditEvents,
  runAuditMaintenance,
  summarizeAuditEvents,
} = require("../services/accessPolicyAuditService.js");
const {
  readAccessPolicyState,
  upsertCollaborationGrant,
  removeCollaborationGrant,
  setUserEntitlements,
} = require("../services/accessPolicyService.js");

const router = express.Router();
const basePath = "/api/access-policies";

async function emitPolicyAudit(req, action, details = {}) {
  const actorUserId = String(req?.user?.id || req?.user?.userId || "").trim() || "unknown";
  const isOk =
    typeof details?.ok === "boolean"
      ? details.ok
      : typeof details?.result?.ok === "boolean"
      ? details.result.ok
      : true;
  const event = {
    type: "access_policy_admin",
    action,
    actorUserId,
    requestId: req?.id || null,
    ok: isOk,
    at: new Date().toISOString(),
    details: redactObject(details),
  };
  try {
    await appendAuditEvent(event);
  } catch {
    // keep admin routes functional even if audit persistence fails
  }
  console.info("[audit:access-policy]", JSON.stringify(event));
}

function requireOpsToken(req, res, next) {
  const configured = String(process.env.ACCESS_POLICY_ADMIN_TOKEN || "").trim();
  if (!configured) {
    return res.status(503).json({ ok: false, error: "policy_admin_token_not_configured" });
  }

  const provided = String(req.headers["x-ops-token"] || "").trim();
  if (!provided || provided !== configured) {
    return res.status(403).json({ ok: false, error: "forbidden" });
  }

  return next();
}

router.use(authenticateRequest);
router.use(requireOpsToken);

router.get("/", async (_req, res, next) => {
  try {
    const policy = await readAccessPolicyState();
    await emitPolicyAudit(_req, "policy.read", {
      collaborationGrantCount: Array.isArray(policy?.collaborationGrants)
        ? policy.collaborationGrants.length
        : 0,
      entitlementUserCount: Object.keys(policy?.entitlementGrantsByUserId || {}).length,
    });
    return res.json({ ok: true, policy });
  } catch (error) {
    return next(error);
  }
});

router.get("/audit-events", async (req, res, next) => {
  try {
    const out = await listAuditEvents({
      action: req.query?.action,
      actorUserId: req.query?.actorUserId,
      since: req.query?.since,
      limit: req.query?.limit,
    });
    await emitPolicyAudit(req, "policy.audit_events.read", {
      action: req.query?.action || null,
      actorUserId: req.query?.actorUserId || null,
      since: req.query?.since || null,
      limit: req.query?.limit || null,
      resultCount: out.count,
    });
    return res.json(out);
  } catch (error) {
    return next(error);
  }
});

router.get("/audit-events/summary", async (req, res, next) => {
  try {
    const out = await summarizeAuditEvents({
      windowMs: req.query?.windowMs,
    });
    await emitPolicyAudit(req, "policy.audit_events.summary.read", {
      windowMs: req.query?.windowMs || null,
      totalEvents: out.totalEvents,
      totalInWindow: out.totalInWindow,
      failuresInWindow: out.failuresInWindow,
    });
    return res.json(out);
  } catch (error) {
    return next(error);
  }
});

router.get("/audit-events/alerts", async (req, res, next) => {
  try {
    const out = await listAuditAlerts({
      windowMs: req.query?.windowMs,
      failureRateThreshold: req.query?.failureRateThreshold,
      minEvents: req.query?.minEvents,
      highRiskActionThreshold: req.query?.highRiskActionThreshold,
      highRiskActions: req.query?.highRiskActions,
    });
    await emitPolicyAudit(req, "policy.audit_events.alerts.read", {
      windowMs: req.query?.windowMs || null,
      failureRateThreshold: req.query?.failureRateThreshold || null,
      minEvents: req.query?.minEvents || null,
      highRiskActionThreshold: req.query?.highRiskActionThreshold || null,
      highRiskActions: req.query?.highRiskActions || null,
      alertCount: Array.isArray(out?.alerts) ? out.alerts.length : 0,
    });
    return res.json(out);
  } catch (error) {
    return next(error);
  }
});

router.get("/audit-events/anomalies", async (req, res, next) => {
  try {
    const out = await listAuditAnomalies({
      windowMs: req.query?.windowMs,
      minActorEvents: req.query?.minActorEvents,
      failureRateThreshold: req.query?.failureRateThreshold,
      highRiskActionThreshold: req.query?.highRiskActionThreshold,
      highRiskActions: req.query?.highRiskActions,
      maxActors: req.query?.maxActors,
      sampleLimit: req.query?.sampleLimit,
    });
    await emitPolicyAudit(req, "policy.audit_events.anomalies.read", {
      windowMs: req.query?.windowMs || null,
      minActorEvents: req.query?.minActorEvents || null,
      failureRateThreshold: req.query?.failureRateThreshold || null,
      highRiskActionThreshold: req.query?.highRiskActionThreshold || null,
      highRiskActions: req.query?.highRiskActions || null,
      maxActors: req.query?.maxActors || null,
      sampleLimit: req.query?.sampleLimit || null,
      anomalyCount: Array.isArray(out?.anomalies) ? out.anomalies.length : 0,
    });
    return res.json(out);
  } catch (error) {
    return next(error);
  }
});

router.post("/audit-events/maintenance", express.json(), async (req, res, next) => {
  try {
    const body = req.body || {};
    const out = await runAuditMaintenance({
      maxEvents: body.maxEvents ?? req.query?.maxEvents,
      retentionMs: body.retentionMs ?? req.query?.retentionMs,
      rolloverEnabled: body.rolloverEnabled ?? req.query?.rolloverEnabled,
    });
    await emitPolicyAudit(req, "policy.audit_events.maintenance.run", {
      maxEvents: body.maxEvents ?? req.query?.maxEvents ?? null,
      retentionMs: body.retentionMs ?? req.query?.retentionMs ?? null,
      rolloverEnabled: body.rolloverEnabled ?? req.query?.rolloverEnabled ?? null,
      result: out,
    });
    return res.json(out);
  } catch (error) {
    return next(error);
  }
});

router.post("/collaboration-grants/upsert", express.json(), async (req, res, next) => {
  try {
    const body = req.body || {};
    const grant = await upsertCollaborationGrant({
      userId: body.userId,
      householdId: body.householdId,
      moduleKey: body.moduleKey,
      actions: body.actions,
      startsAt: body.startsAt,
      expiresAt: body.expiresAt,
    });
    await emitPolicyAudit(req, "collaboration_grant.upsert", {
      userId: body.userId,
      householdId: body.householdId,
      moduleKey: body.moduleKey,
      actions: body.actions,
      startsAt: body.startsAt,
      expiresAt: body.expiresAt,
      payload: body,
      ok: true,
    });
    return res.json({ ok: true, grant });
  } catch (error) {
    if (String(error?.message || "") === "invalid_collaboration_grant") {
      await emitPolicyAudit(req, "collaboration_grant.upsert", {
        userId: req.body?.userId,
        householdId: req.body?.householdId,
        moduleKey: req.body?.moduleKey,
        payload: req.body || {},
        ok: false,
        error: "invalid_collaboration_grant",
      });
      return res.status(400).json({ ok: false, error: "invalid_collaboration_grant" });
    }
    return next(error);
  }
});

router.delete("/collaboration-grants", express.json(), async (req, res, next) => {
  try {
    const body = req.body || {};
    const result = await removeCollaborationGrant({
      userId: body.userId,
      householdId: body.householdId,
      moduleKey: body.moduleKey,
    });
    await emitPolicyAudit(req, "collaboration_grant.delete", {
      userId: body.userId,
      householdId: body.householdId,
      moduleKey: body.moduleKey,
      payload: body,
      removed: Boolean(result?.removed),
      ok: true,
    });
    return res.json({ ok: true, ...result });
  } catch (error) {
    if (String(error?.message || "") === "invalid_collaboration_grant") {
      await emitPolicyAudit(req, "collaboration_grant.delete", {
        userId: req.body?.userId,
        householdId: req.body?.householdId,
        moduleKey: req.body?.moduleKey,
        payload: req.body || {},
        ok: false,
        error: "invalid_collaboration_grant",
      });
      return res.status(400).json({ ok: false, error: "invalid_collaboration_grant" });
    }
    return next(error);
  }
});

router.put("/entitlements/:userId", express.json(), async (req, res, next) => {
  try {
    const result = await setUserEntitlements({
      userId: req.params.userId,
      entitlements: req.body?.entitlements,
    });
    await emitPolicyAudit(req, "entitlement.set", {
      userId: req.params.userId,
      entitlements: req.body?.entitlements,
      payload: req.body || {},
      ok: true,
    });
    return res.json({ ok: true, ...result });
  } catch (error) {
    if (String(error?.message || "") === "invalid_user_id") {
      await emitPolicyAudit(req, "entitlement.set", {
        userId: req.params?.userId,
        entitlements: req.body?.entitlements,
        payload: req.body || {},
        ok: false,
        error: "invalid_user_id",
      });
      return res.status(400).json({ ok: false, error: "invalid_user_id" });
    }
    return next(error);
  }
});

module.exports = { router, basePath };
