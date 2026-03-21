"use strict";

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
  if (req?.body && typeof req.body === "object" && !Array.isArray(req.body) && !req.body.householdId) {
    req.body.householdId = householdId;
  }
}

function requireHouseholdAccessStub() {
  return (req, res, next) => {
    const userHouseholdId = String(req?.user?.homeId || req?.user?.householdId || "").trim() || null;
    if (!userHouseholdId) {
      return res.status(403).json({ ok: false, error: "household_membership_required" });
    }

    const requestedHouseholdId = readRequestedHouseholdId(req);
    if (requestedHouseholdId && requestedHouseholdId !== userHouseholdId) {
      return res.status(403).json({ ok: false, error: "household_scope_forbidden" });
    }

    ensureRequestHousehold(req, requestedHouseholdId || userHouseholdId);
    req.accessContext = {
      ...(req.accessContext || {}),
      householdId: userHouseholdId,
      requestedHouseholdId: requestedHouseholdId || userHouseholdId,
      collaborationGranted: false,
      entitlementGranted: true,
    };
    return next();
  };
}

function requireCollaborationStub({ moduleKey = "unknown" } = {}) {
  return (req, _res, next) => {
    const collaborationToken = String(req?.headers?.["x-collaboration-grant"] || "").trim();
    const collaborationGranted = Boolean(collaborationToken);

    req.accessContext = {
      ...(req.accessContext || {}),
      moduleKey,
      collaborationGranted,
      collaborationDecision: collaborationGranted ? "header_grant" : "household_only",
    };
    return next();
  };
}

function requireEntitlementStub({ feature = "planner.base" } = {}) {
  return (req, _res, next) => {
    const entitlementToken = String(req?.headers?.["x-entitlements"] || "")
      .split(",")
      .map((value) => String(value || "").trim())
      .filter(Boolean);

    const entitlementGranted =
      entitlementToken.includes("all") || entitlementToken.includes(feature) || entitlementToken.length === 0;

    req.accessContext = {
      ...(req.accessContext || {}),
      entitlementFeature: feature,
      entitlementGranted,
      entitlementToken,
    };
    return next();
  };
}

module.exports = {
  requireHouseholdAccessStub,
  requireCollaborationStub,
  requireEntitlementStub,
};
