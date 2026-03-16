"use strict";

class RealtimeError extends Error {
  constructor(code, status, reason = null) {
    super(code);
    this.code = code;
    this.status = status;
    this.reason = reason;
  }
}

function hasElevatedRole(roles = []) {
  const set = new Set((roles || []).map((r) => String(r || "").toLowerCase()));
  return set.has("admin") || set.has("owner") || set.has("family_admin") || set.has("household_admin");
}

function resolveAuthorizedScope(requester, requestedScope, requestedScopeId) {
  const scope = requestedScope === "family" ? "family" : "household";
  const scopeId = requestedScopeId ? String(requestedScopeId) : null;

  if (!scopeId) {
    if (scope === "family") {
      throw new RealtimeError("family_scope_forbidden", 403);
    }
    throw new RealtimeError("household_scope_missing", 403);
  }

  if (!hasElevatedRole(requester.roles || [])) {
    if (scope === "family" && requester.familyId && String(scopeId) !== String(requester.familyId)) {
      throw new RealtimeError("forbidden_scope", 403);
    }
    if (scope === "household" && requester.homeId && String(scopeId) !== String(requester.homeId)) {
      throw new RealtimeError("forbidden_scope", 403);
    }
  }

  return { scope, scopeId };
}

function authorizeScope(req, res, next) {
  try {
    const requester = req.realtime?.requester || req.user || {};
    const resolved = resolveAuthorizedScope(requester, req.realtime?.scope, req.realtime?.scopeId);
    req.realtime.scope = resolved.scope;
    req.realtime.scopeId = resolved.scopeId;
    next();
  } catch (err) {
    next(err);
  }
}

function authorizeSocketScope(socket, payload = {}) {
  const requester = {
    userId: socket?.user?.id || null,
    homeId: socket?.user?.homeId || null,
    familyId: socket?.user?.familyId || null,
    roles: socket?.user?.roles || [],
  };

  const resolved = resolveAuthorizedScope(requester, payload.scope, payload.scopeId);
  return {
    ...payload,
    scope: resolved.scope,
    scopeId: resolved.scopeId,
  };
}

module.exports = {
  authorizeScope,
  authorizeSocketScope,
  RealtimeError,
};
