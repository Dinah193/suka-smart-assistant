"use strict";

const { v4: uuidv4 } = require("uuid");

function toList(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v.map((x) => String(x || "").trim()).filter(Boolean);
  return String(v)
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function ensureRealtime(req) {
  if (!req.realtime || typeof req.realtime !== "object") {
    req.realtime = {};
  }
  return req.realtime;
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

function resolveScope(req, requester) {
  const scope = req.query.scope === "family" || req.body?.scope === "family" ? "family" : "household";
  const scopeId =
    scope === "family"
      ? req.query.familyId || req.body?.familyId || requester.familyId || null
      : req.query.householdId || req.query.homeId || req.body?.householdId || req.body?.homeId || requester.homeId || null;
  return { scope, scopeId: scopeId ? String(scopeId) : null };
}

function buildIdempotencyKey(payload, context) {
  const eventId = payload?.eventId || payload?.meta?.eventId || null;
  if (eventId) return `event:${eventId}`;

  const eventType = payload?.event || payload?.type || "unknown";
  return `corr:${context.correlationId}:${eventType}:${context.scope}:${context.scopeId || "default"}`;
}

function correlationContext(req, res, next) {
  const ctx = ensureRealtime(req);
  const requester = requesterFromReq(req);

  const correlationId = req.headers["x-correlation-id"] || req.headers["x-request-id"] || req.id || uuidv4();
  const scopeResolved = resolveScope(req, requester);

  const signalPayload = req.body?.signal || req.body || {};
  const eventId = signalPayload?.eventId || signalPayload?.meta?.eventId || uuidv4();

  ctx.requestId = req.id || correlationId;
  ctx.correlationId = String(correlationId);
  ctx.eventId = String(eventId);
  ctx.requester = requester;
  ctx.scope = scopeResolved.scope;
  ctx.scopeId = scopeResolved.scopeId;
  ctx.idempotencyKey = buildIdempotencyKey(signalPayload, {
    correlationId: ctx.correlationId,
    scope: ctx.scope,
    scopeId: ctx.scopeId,
  });

  res.setHeader("x-correlation-id", ctx.correlationId);
  res.setHeader("x-event-id", ctx.eventId);
  next();
}

function applySocketCorrelationContext(socket, payload = {}, { eventName = "signal:emit" } = {}) {
  const correlationId =
    payload?.correlationId || payload?.meta?.correlationId || socket?.handshake?.headers?.["x-correlation-id"] || uuidv4();
  const eventId = payload?.eventId || payload?.meta?.eventId || uuidv4();
  const scope = payload?.scope === "family" ? "family" : "household";
  const scopeId =
    payload?.scopeId ||
    (scope === "family" ? socket?.user?.familyId : socket?.user?.homeId) ||
    "default";

  const enriched = {
    ...(payload || {}),
    event: payload?.event || payload?.type || null,
    eventId: String(eventId),
    correlationId: String(correlationId),
    scope,
    scopeId: String(scopeId),
  };

  return {
    payload: enriched,
    context: {
      requestId: uuidv4(),
      correlationId: enriched.correlationId,
      eventId: enriched.eventId,
      scope,
      scopeId: enriched.scopeId,
      idempotencyKey: buildIdempotencyKey(enriched, {
        correlationId: enriched.correlationId,
        scope,
        scopeId: enriched.scopeId,
      }),
    },
  };
}

module.exports = {
  correlationContext,
  applySocketCorrelationContext,
  requesterFromReq,
};
