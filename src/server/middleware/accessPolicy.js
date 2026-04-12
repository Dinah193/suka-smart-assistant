"use strict";

const {
  methodToAction,
  resolveHouseholdAccess,
  hasCollaborationGrant,
  hasEntitlement,
} = require("../services/accessPolicyService.js");
const {
  HOUSEHOLD_ROLES,
  PLANNER_ADMIN_ROLES,
} = require("../contracts/householdSocialContract.js");

function isTruthy(value) {
  const normalized = String(value == null ? "" : value).trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function isLocalhostHost(hostname) {
  const host = String(hostname || "").trim().toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

function allowLocalDevPolicyBypass(req) {
  if (String(process.env.NODE_ENV || "").toLowerCase() === "production") {
    return false;
  }

  const bypassSetting = process.env.SSA_DEV_POLICY_BYPASS;
  if (!isTruthy(bypassSetting)) {
    return false;
  }

  const forwardedHost = String(req?.headers?.["x-forwarded-host"] || "").split(",")[0].trim();
  const host = req?.hostname || req?.headers?.host || forwardedHost;
  return isLocalhostHost(String(host || "").split(":")[0]);
}

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
      if (allowLocalDevPolicyBypass(req)) {
        const requestedHouseholdId = readRequestedHouseholdId(req) || "default-household";
        ensureRequestHousehold(req, requestedHouseholdId);
        req.user = {
          ...(req.user || {}),
          id: String(req?.user?.id || req?.user?.userId || "dev-local-user"),
          roles: Array.isArray(req?.user?.roles)
            ? req.user.roles
            : [HOUSEHOLD_ROLES.OWNER, HOUSEHOLD_ROLES.ADMIN],
        };
        req.accessContext = {
          ...(req.accessContext || {}),
          userId: req.user.id,
          action: methodToAction(req.method),
          ownHouseholdId: requestedHouseholdId,
          householdId: requestedHouseholdId,
          requestedHouseholdId,
          sameHousehold: true,
          role: HOUSEHOLD_ROLES.OWNER,
          devPolicyBypass: true,
        };
        return next();
      }

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
      if (allowLocalDevPolicyBypass(req)) {
        req.accessContext = {
          ...(req.accessContext || {}),
          moduleKey,
          collaborationGranted: true,
          collaborationDecision: "dev_local_bypass",
        };
        return next();
      }

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
      if (allowLocalDevPolicyBypass(req)) {
        req.accessContext = {
          ...(req.accessContext || {}),
          entitlementFeature: feature,
          entitlementGranted: true,
          entitlementDecision: "dev_local_bypass",
        };
        return next();
      }

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

function normalizeRoleList(values) {
  if (!Array.isArray(values)) return [];
  return values
    .map((value) => String(value || "").trim().toLowerCase())
    .filter(Boolean);
}

function requireRolePolicy({
  allowedRoles = [HOUSEHOLD_ROLES.OWNER, HOUSEHOLD_ROLES.ADMIN],
} = {}) {
  const normalizedAllowedRoles = Array.from(new Set(normalizeRoleList(allowedRoles)));

  return async (req, res, next) => {
    try {
      if (allowLocalDevPolicyBypass(req)) {
        req.accessContext = {
          ...(req.accessContext || {}),
          rolePolicyGranted: true,
          rolePolicyMatchedRole: HOUSEHOLD_ROLES.OWNER,
          rolePolicyDecision: "dev_local_bypass",
        };
        return next();
      }

      const ctx = req.accessContext || {};
      const householdRole = String(ctx.role || "").trim().toLowerCase();
      const accountRoles = normalizeRoleList(req?.user?.roles);
      const requiredSet = new Set(normalizedAllowedRoles);

      const matchedRole =
        (householdRole && requiredSet.has(householdRole) && householdRole) ||
        accountRoles.find((role) => requiredSet.has(role)) ||
        null;

      if (!matchedRole) {
        return res.status(403).json({
          ok: false,
          error: "role_required",
          requiredRoles: normalizedAllowedRoles,
        });
      }

      req.accessContext = {
        ...ctx,
        rolePolicyGranted: true,
        rolePolicyMatchedRole: matchedRole,
      };

      return next();
    } catch (error) {
      return next(error);
    }
  };
}

// Deprecated: prefer requirePlannerAdminRole() in route declarations for clearer intent.
function requireOperationalPlannerRole() {
  return requireRolePolicy({ allowedRoles: PLANNER_ADMIN_ROLES });
}

function requirePlannerAdminRole() {
  return requireRolePolicy({ allowedRoles: PLANNER_ADMIN_ROLES });
}

module.exports = {
  requireHouseholdAccessPolicy,
  requireCollaborationPolicy,
  requireEntitlementPolicy,
  requireRolePolicy,
  requireOperationalPlannerRole,
  requirePlannerAdminRole,
};
