"use strict";

function mapRealtimeError(err) {
  const code = err?.code || err?.message || "internal_error";

  if (code === "forbidden_scope" || code === "family_scope_forbidden" || code === "household_scope_missing") {
    return { status: 403, error: code, reason: err?.reason || null };
  }
  if (code === "unauthorized" || code === "Unauthorized") {
    return { status: 401, error: "unauthorized", reason: err?.reason || null };
  }
  if (code === "duplicate_event") {
    return { status: 409, error: "duplicate_event", reason: err?.reason || "duplicate_event_id" };
  }
  if (code === "invalid_event") {
    return { status: 400, error: "invalid_event", reason: err?.reason || null, details: err?.details || null };
  }
  if (code === "event_log_unavailable") {
    return { status: 503, error: "event_log_unavailable", reason: err?.reason || "append_failed" };
  }
  if (code === "realtime_not_ready") {
    return { status: 503, error: "realtime_not_ready", reason: err?.reason || null };
  }

  return { status: Number(err?.status || 500), error: "internal_error", reason: null };
}

function mapRealtimeErrorMiddleware(err, req, res, next) {
  if (!req.path || !req.baseUrl || !String(req.baseUrl).includes("/api/realtime")) {
    return next(err);
  }

  const mapped = mapRealtimeError(err);
  const out = {
    ok: false,
    error: mapped.error,
  };
  if (mapped.reason) out.reason = mapped.reason;
  if (mapped.details) out.details = mapped.details;
  if (req.realtime?.correlationId) out.correlationId = req.realtime.correlationId;

  return res.status(mapped.status).json(out);
}

function withRealtimeSocketGuard(handler) {
  return async (payload = {}, cb) => {
    try {
      await handler(payload, cb);
    } catch (err) {
      const mapped = mapRealtimeError(err);
      const out = { ok: false, error: mapped.error };
      if (mapped.reason) out.reason = mapped.reason;
      if (mapped.details) out.details = mapped.details;
      if (typeof cb === "function") cb(out);
    }
  };
}

module.exports = {
  mapRealtimeError,
  mapRealtimeErrorMiddleware,
  withRealtimeSocketGuard,
};
