"use strict";

const {
  methodToAction,
  resolveHouseholdAccess,
  hasCollaborationGrant,
  hasEntitlement,
} = require("../services/accessPolicyService.js");

function readRequestedHouseholdId(req) {
  const fromParams = req?.params?.householdId;
  const fromQuery = req?.query?.householdId || req?.query?.householdKey;
  const fromBody = req?.body?.householdId || req?.body?.householdKey;
  return String(fromParams || fromQuery || fromBody || "").trim() || null;
}

function ensureRequestHousehold(req, householdId) {
  if (!householdId) return;
  if (req?.query && !req.query.householdId) {
    req.query.householdId = householdId;
  }
  if (
    req?.body &&
    typeof req.body === "object" &&
    !Array.isArray(req.body) &&
    !req.body.householdId
  ) {
    req.body.householdId = householdId;
  }
}

function requireHouseholdAccessPolicy() {
  return async (req, res, next) => {
    try {
      const userId = String(req?.user?.id || req?.user?.userId || "").trim();
      if (!userId) {
        return res.status(401).json({ ok: false, error: "unauthorized" });
      }

      const requestedHouseholdId = readRequestedHouseholdId(req);
      const access = await resolveHouseholdAccess({
        userId,
        requestedHouseholdId,
      });

      if (!access.ownHouseholdId) {
        return res.status(403).json({ ok: false, error: "household_membership_required" });
      }

      if (!access.requestedHouseholdId) {
        return res.status(403).json({ ok: false, error: "household_scope_required" });
      }

      ensureRequestHousehold(req, access.requestedHouseholdId);
      req.accessContext = {
        ...(req.accessContext || {}),
        userId,
        action: methodToAction(req.method),
        ownHouseholdId: access.ownHouseholdId,
        householdId: access.requestedHouseholdId,
        requestedHouseholdId: access.requestedHouseholdId,
        sameHousehold: access.sameHousehold,
        role: access.role || null,
      };

      return next();
    } catch (error) {
      return next(error);
    }
  };
}

function requireCollaborationPolicy({ moduleKey = "unknown" } = {}) {
  return async (req, res, next) => {
    try {
      const ctx = req.accessContext || {};
      if (ctx.sameHousehold) {
        req.accessContext = {
          ...ctx,
          moduleKey,
          collaborationGranted: true,
          collaborationDecision: "same_household",
        };
        return next();
      }

      const granted = await hasCollaborationGrant({
        userId: ctx.userId,
        moduleKey,
        householdId: ctx.householdId,
        action: ctx.action || methodToAction(req.method),
      });

      if (!granted) {
        return res.status(403).json({ ok: false, error: "collaboration_required" });
      }

      req.accessContext = {
        ...ctx,
        moduleKey,
        collaborationGranted: true,
        collaborationDecision: "policy_grant",
      };

      return next();
    } catch (error) {
      return next(error);
    }
  };
}

function requireEntitlementPolicy({ feature = "planner.base" } = {}) {
  return async (req, res, next) => {
    try {
      const ctx = req.accessContext || {};
      const granted = await hasEntitlement({
        userId: ctx.userId,
        feature,
      });

      if (!granted) {
        return res.status(403).json({ ok: false, error: "entitlement_required", feature });
      }

      req.accessContext = {
        ...ctx,
        entitlementFeature: feature,
        entitlementGranted: true,
      };
      return next();
    } catch (error) {
      return next(error);
    }
  };
}

module.exports = {
  requireHouseholdAccessPolicy,
  requireCollaborationPolicy,
  requireEntitlementPolicy,
};
