import { describe, it, expect } from "vitest";

const validationPath = "../src/server/services/envValidation.js";

function withEnv(overrides, run) {
  const prev = {
    NODE_ENV: process.env.NODE_ENV,
    STRICT_STARTUP_ENV: process.env.STRICT_STARTUP_ENV,
    MONGODB_URI: process.env.MONGODB_URI,
    N8N_INBOUND_SECRET: process.env.N8N_INBOUND_SECRET,
    JWT_SECRET: process.env.JWT_SECRET,
    CORS_ORIGIN: process.env.CORS_ORIGIN,
    SOCKET_CORS: process.env.SOCKET_CORS,
    ALLOW_INSECURE_HEADER_AUTH: process.env.ALLOW_INSECURE_HEADER_AUTH,
  };

  Object.assign(process.env, overrides);
  try {
    run();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v == null) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe("envValidation production security checks", () => {
  it("fails when production CORS is wildcard", () => {
    withEnv(
      {
        NODE_ENV: "production",
        STRICT_STARTUP_ENV: "true",
        MONGODB_URI: "mongodb://localhost:27017/test",
        N8N_INBOUND_SECRET: "secret",
        JWT_SECRET: "jwt",
        CORS_ORIGIN: "*",
        SOCKET_CORS: "https://app.example.com",
        ALLOW_INSECURE_HEADER_AUTH: "false",
      },
      () => {
        const { validateStartupEnv } = require(validationPath);
        const out = validateStartupEnv({ nodeEnv: "production" });
        expect(out.ok).toBe(false);
        expect(out.errors.join(" ")).toMatch(/CORS_ORIGIN/i);
      }
    );
  });

  it("fails when insecure header auth fallback is enabled in production", () => {
    withEnv(
      {
        NODE_ENV: "production",
        STRICT_STARTUP_ENV: "true",
        MONGODB_URI: "mongodb://localhost:27017/test",
        N8N_INBOUND_SECRET: "secret",
        JWT_SECRET: "jwt",
        CORS_ORIGIN: "https://app.example.com",
        SOCKET_CORS: "https://app.example.com",
        ALLOW_INSECURE_HEADER_AUTH: "true",
      },
      () => {
        const { validateStartupEnv } = require(validationPath);
        const out = validateStartupEnv({ nodeEnv: "production" });
        expect(out.ok).toBe(false);
        expect(out.errors.join(" ")).toMatch(/ALLOW_INSECURE_HEADER_AUTH/i);
      }
    );
  });
});
