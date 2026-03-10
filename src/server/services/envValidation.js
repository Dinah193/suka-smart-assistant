"use strict";

function hasAny(names = []) {
  for (const name of names) {
    const raw = process.env[name];
    if (raw != null && String(raw).trim() !== "") return true;
  }
  return false;
}

function getMissing(names = []) {
  return names.filter((name) => {
    const raw = process.env[name];
    return raw == null || String(raw).trim() === "";
  });
}

function validateStartupEnv({ nodeEnv = "development" } = {}) {
  const normalizedEnv = String(nodeEnv || "development").toLowerCase();
  const strict = String(process.env.STRICT_STARTUP_ENV || "false").toLowerCase() === "true";
  const isProd = normalizedEnv === "production";

  const warnings = [];
  const errors = [];

  const checks = {
    mongoUriConfigured: hasAny(["MONGODB_URI", "MONGO_URI", "MONGO_URL"]),
    n8nSecretConfigured: hasAny(["N8N_INBOUND_SECRET", "N8N_SHARED_SECRET"]),
    jwtSecretConfigured: hasAny(["JWT_SECRET"]),
    corsOriginConfigured: hasAny(["CORS_ORIGIN"]),
  };

  const corsOriginRaw = String(process.env.CORS_ORIGIN || "").trim();
  const socketCorsRaw = String(process.env.SOCKET_CORS || "").trim();
  const allowInsecureHeaderAuth =
    String(process.env.ALLOW_INSECURE_HEADER_AUTH || "false").toLowerCase() === "true";

  if (!checks.mongoUriConfigured) {
    warnings.push("Mongo URI is not configured (MONGODB_URI/MONGO_URI/MONGO_URL); backend will run in file-fallback mode.");
  }

  if (!checks.n8nSecretConfigured) {
    warnings.push("n8n inbound webhook secret is not configured (N8N_INBOUND_SECRET/N8N_SHARED_SECRET); signatures cannot be verified.");
  }

  if (isProd && !checks.mongoUriConfigured) {
    errors.push("Production requires MONGODB_URI (or MONGO_URI/MONGO_URL).");
  }

  if (isProd && !checks.n8nSecretConfigured) {
    errors.push("Production requires N8N_INBOUND_SECRET (or N8N_SHARED_SECRET).");
  }

  if (isProd && !checks.jwtSecretConfigured) {
    warnings.push("JWT_SECRET is not configured; auth integrations may be weaker than expected.");
  }

  if (isProd && (!checks.corsOriginConfigured || corsOriginRaw === "*")) {
    errors.push("Production requires explicit CORS_ORIGIN (wildcard '*' is not allowed).");
  }

  if (isProd && socketCorsRaw === "*") {
    errors.push("Production requires explicit SOCKET_CORS (wildcard '*' is not allowed).");
  }

  if (isProd && allowInsecureHeaderAuth) {
    errors.push("ALLOW_INSECURE_HEADER_AUTH=true is forbidden in production.");
  }

  return {
    ok: errors.length === 0,
    strict,
    isProd,
    warnings,
    errors,
    checks,
  };
}

module.exports = {
  validateStartupEnv,
};
