"use strict";

const { validateStartupEnv } = require("../../src/server/services/envValidation.js");

function withEnv(overrides, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(overrides)) {
    previous[key] = Object.prototype.hasOwnProperty.call(process.env, key)
      ? process.env[key]
      : undefined;
    if (value == null) {
      delete process.env[key];
    } else {
      process.env[key] = String(value);
    }
  }

  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function run() {
  const good = withEnv(
    {
      STRICT_STARTUP_ENV: "true",
      CORS_ORIGIN: "https://app.example.com",
      SOCKET_CORS: "https://app.example.com",
      N8N_INBOUND_SECRET: "n8n-secret",
      MONGODB_URI: "mongodb://127.0.0.1:27017/suka",
      AUTH_ACCESS_TOKEN_SECRETS: "key-new,key-old",
      AUTH_ACCESS_TOKEN_SECRET: null,
      AUTH_COOKIE_SECURE: "true",
      AUTH_COOKIE_SAME_SITE: "none",
      ALLOW_INSECURE_HEADER_AUTH: "false",
    },
    () => validateStartupEnv({ nodeEnv: "production" })
  );

  assert(good.ok, `expected secure production config to pass, got errors: ${JSON.stringify(good.errors)}`);

  const bad = withEnv(
    {
      STRICT_STARTUP_ENV: "true",
      CORS_ORIGIN: "https://app.example.com",
      SOCKET_CORS: "https://app.example.com",
      N8N_INBOUND_SECRET: "n8n-secret",
      MONGODB_URI: "mongodb://127.0.0.1:27017/suka",
      AUTH_ACCESS_TOKEN_SECRETS: null,
      AUTH_ACCESS_TOKEN_SECRET: "dev_access_secret_change_me",
      AUTH_COOKIE_SECURE: "false",
      AUTH_COOKIE_SAME_SITE: "none",
      ALLOW_INSECURE_HEADER_AUTH: "false",
    },
    () => validateStartupEnv({ nodeEnv: "production" })
  );

  assert(!bad.ok, "expected insecure production auth config to fail readiness checks");
  assert(
    Array.isArray(bad.errors) && bad.errors.some((x) => String(x).includes("AUTH_COOKIE_SECURE=false")),
    `expected AUTH_COOKIE_SECURE production error, got: ${JSON.stringify(bad.errors)}`
  );
  assert(
    Array.isArray(bad.errors) && bad.errors.some((x) => String(x).includes("development default")),
    `expected default-secret production error, got: ${JSON.stringify(bad.errors)}`
  );

  console.log(
    JSON.stringify(
      {
        ok: true,
        checks: {
          secureProductionConfig: "pass",
          insecureProductionConfig: "fail-as-expected",
        },
      },
      null,
      2
    )
  );
}

try {
  run();
} catch (error) {
  console.error("[auth-env-readiness] failed:", error?.message || error);
  process.exit(1);
}
