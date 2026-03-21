"use strict";

const express = require("express");
const { authenticateRequest } = require("../middleware/realtime/authenticateRequest.js");
const { redactObject } = require("../services/loggingSanitizer.js");
const {
  readAccessPolicyState,
  upsertCollaborationGrant,
  removeCollaborationGrant,
  setUserEntitlements,
} = require("../services/accessPolicyService.js");

const router = express.Router();
const basePath = "/api/access-policies";

function emitPolicyAudit(req, action, details = {}) {
  const actorUserId = String(req?.user?.id || req?.user?.userId || "").trim() || "unknown";
  const event = {
    type: "access_policy_admin",
    action,
    actorUserId,
    requestId: req?.id || null,
    at: new Date().toISOString(),
    details: redactObject(details),
  };
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
    emitPolicyAudit(_req, "policy.read", {
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
    emitPolicyAudit(req, "collaboration_grant.upsert", {
      userId: body.userId,
      householdId: body.householdId,
      moduleKey: body.moduleKey,
      actions: body.actions,
      startsAt: body.startsAt,
      expiresAt: body.expiresAt,
      ok: true,
    });
    return res.json({ ok: true, grant });
  } catch (error) {
    if (String(error?.message || "") === "invalid_collaboration_grant") {
      emitPolicyAudit(req, "collaboration_grant.upsert", {
        userId: req.body?.userId,
        householdId: req.body?.householdId,
        moduleKey: req.body?.moduleKey,
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
    emitPolicyAudit(req, "collaboration_grant.delete", {
      userId: body.userId,
      householdId: body.householdId,
      moduleKey: body.moduleKey,
      removed: Boolean(result?.removed),
      ok: true,
    });
    return res.json({ ok: true, ...result });
  } catch (error) {
    if (String(error?.message || "") === "invalid_collaboration_grant") {
      emitPolicyAudit(req, "collaboration_grant.delete", {
        userId: req.body?.userId,
        householdId: req.body?.householdId,
        moduleKey: req.body?.moduleKey,
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
    emitPolicyAudit(req, "entitlement.set", {
      userId: req.params.userId,
      entitlements: req.body?.entitlements,
      ok: true,
    });
    return res.json({ ok: true, ...result });
  } catch (error) {
    if (String(error?.message || "") === "invalid_user_id") {
      emitPolicyAudit(req, "entitlement.set", {
        userId: req.params?.userId,
        entitlements: req.body?.entitlements,
        ok: false,
        error: "invalid_user_id",
      });
      return res.status(400).json({ ok: false, error: "invalid_user_id" });
    }
    return next(error);
  }
});

module.exports = { router, basePath };
