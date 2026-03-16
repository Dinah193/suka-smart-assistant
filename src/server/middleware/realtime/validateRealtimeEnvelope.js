"use strict";

const fs = require("fs");
const path = require("path");
const Ajv2020 = require("ajv/dist/2020");
const addFormats = require("ajv-formats");

const schemaPath = path.resolve(__dirname, "../../../schemas/realtime.event.envelope.schema.json");
const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));

const ajv = new Ajv2020({ allErrors: true, strict: false, useDefaults: true });
addFormats(ajv);
const validateEnvelope = ajv.compile(schema);

function shouldValidateHttp(req) {
  return req.method === "POST" && req.path === "/signals";
}

function validateRealtimeEnvelope(req, res, next) {
  try {
    if (!shouldValidateHttp(req)) return next();

    const payload = req.body?.signal || req.body || {};
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return res.status(400).json({
        ok: false,
        error: "invalid_event",
        reason: "signal_not_object",
      });
    }
    if (!payload.event && !payload.type) {
      return res.status(400).json({
        ok: false,
        error: "invalid_event",
        reason: "missing_event_type",
      });
    }

    payload.scope = payload.scope || req.realtime?.scope || "household";
    payload.scopeId = payload.scopeId || req.realtime?.scopeId || null;
    payload.eventId = payload.eventId || req.realtime?.eventId;
    payload.correlationId = payload.correlationId || req.realtime?.correlationId;
    payload.actorId = payload.actorId || req.realtime?.requester?.userId || req.user?.id || null;
    payload.sourceModule = payload.sourceModule || "http.realtime";
    payload.version = payload.version || "v1";
    payload.event = payload.event || payload.type || "signal:emit";

    const ok = validateEnvelope(payload);
    if (!ok) {
      return res.status(400).json({
        ok: false,
        error: "invalid_event",
        reason: "schema_validation_failed",
        details: (validateEnvelope.errors || []).map((e) => ({ path: e.instancePath || "/", message: e.message })),
      });
    }

    req.realtime.envelope = payload;
    if (req.body?.signal) req.body.signal = payload;
    else req.body = payload;
    return next();
  } catch (err) {
    return next(err);
  }
}

function validateSocketRealtimeEnvelope(payload = {}, { actorId = null, sourceModule = "socket.realtime" } = {}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    const err = new Error("invalid_event");
    err.code = "invalid_event";
    err.status = 400;
    err.reason = "signal_not_object";
    throw err;
  }

  if (!payload.event && !payload.type) {
    const err = new Error("invalid_event");
    err.code = "invalid_event";
    err.status = 400;
    err.reason = "missing_event_type";
    throw err;
  }

  const enriched = {
    ...(payload || {}),
    scope: payload?.scope || "household",
    eventId: payload?.eventId || null,
    correlationId: payload?.correlationId || null,
    actorId: payload?.actorId || actorId || null,
    sourceModule: payload?.sourceModule || sourceModule,
    version: payload?.version || "v1",
    event: payload?.event || payload?.type || "signal:emit",
  };

  const ok = validateEnvelope(enriched);
  if (!ok) {
    const err = new Error("invalid_event");
    err.code = "invalid_event";
    err.status = 400;
    err.reason = "schema_validation_failed";
    err.details = (validateEnvelope.errors || []).map((e) => ({ path: e.instancePath || "/", message: e.message }));
    throw err;
  }

  return enriched;
}

module.exports = {
  validateRealtimeEnvelope,
  validateSocketRealtimeEnvelope,
};
