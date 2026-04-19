"use strict";

const RETRYABLE_ERROR_CODES = new Set([
  "service_unavailable",
  "planner_integration_unavailable",
  "operational_readiness_unavailable",
  "rate_limited",
  "timeout",
  "upstream_timeout",
  "upstream_unavailable",
  "temporary_failure",
]);

function normalizeErrorCode(value, fallback = "unknown_error") {
  const raw = String(value || "").trim();
  if (!raw) return fallback;
  return raw
    .replace(/\s+/g, "_")
    .replace(/[^a-zA-Z0-9_.-]/g, "_")
    .toLowerCase();
}

function shouldRetryError({ statusCode, code }) {
  const normalizedCode = normalizeErrorCode(code);
  const status = Number(statusCode) || 500;
  if (RETRYABLE_ERROR_CODES.has(normalizedCode)) return true;
  if (status === 429) return true;
  if (status >= 500) return true;
  return false;
}

function normalizeErrorDetails(details) {
  if (details == null) return null;
  if (Array.isArray(details)) return details;
  if (typeof details === "object") return details;
  return { value: details };
}

function normalizeApiErrorBody(body, { statusCode = 500, requestId = null } = {}) {
  const src = body && typeof body === "object" ? body : {};
  const code = normalizeErrorCode(src.code || src.error || "unknown_error");
  const message = String(src.message || src.error || code || "unknown_error").trim() || "unknown_error";
  const retryable =
    typeof src.retryable === "boolean"
      ? src.retryable
      : shouldRetryError({ statusCode, code });

  const reservedKeys = new Set(["ok", "code", "error", "message", "retryable", "details", "requestId"]);
  const passthrough = Object.keys(src).reduce((acc, key) => {
    if (reservedKeys.has(key)) return acc;
    acc[key] = src[key];
    return acc;
  }, {});

  const details = normalizeErrorDetails(src.details);

  return {
    ok: false,
    code,
    error: code,
    message,
    retryable,
    details,
    requestId: requestId ? String(requestId) : null,
    ...passthrough,
  };
}

function applyApiErrorEnvelopeMiddleware(router) {
  router.use((req, res, next) => {
    const originalJson = res.json.bind(res);

    res.json = (body) => {
      if (body && typeof body === "object" && body.ok === false) {
        const envelope = normalizeApiErrorBody(body, {
          statusCode: res.statusCode,
          requestId: req.id,
        });
        return originalJson(envelope);
      }
      return originalJson(body);
    };

    return next();
  });

  return router;
}

module.exports = {
  RETRYABLE_ERROR_CODES,
  normalizeErrorCode,
  shouldRetryError,
  normalizeApiErrorBody,
  applyApiErrorEnvelopeMiddleware,
};
