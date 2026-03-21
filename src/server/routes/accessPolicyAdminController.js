"use strict";

const express = require("express");
const { authenticateRequest } = require("../middleware/realtime/authenticateRequest.js");
const {
  readAccessPolicyState,
  upsertCollaborationGrant,
  removeCollaborationGrant,
  setUserEntitlements,
} = require("../services/accessPolicyService.js");

const router = express.Router();
const basePath = "/api/access-policies";

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
    return res.json({ ok: true, grant });
  } catch (error) {
    if (String(error?.message || "") === "invalid_collaboration_grant") {
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
    return res.json({ ok: true, ...result });
  } catch (error) {
    if (String(error?.message || "") === "invalid_collaboration_grant") {
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
    return res.json({ ok: true, ...result });
  } catch (error) {
    if (String(error?.message || "") === "invalid_user_id") {
      return res.status(400).json({ ok: false, error: "invalid_user_id" });
    }
    return next(error);
  }
});

module.exports = { router, basePath };
